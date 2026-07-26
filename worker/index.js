import ExcelJS from "exceljs";
import axios from "axios";
import pg from "pg";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const decisionApi = axios.create({
  baseURL: process.env.DECISION_SERVICE_URL,
  headers: { Authorization: `Bearer ${process.env.DECISION_SERVICE_API_KEY}` },
  timeout: 10_000,
});

// Maps the spreadsheet's actual column headers to internal field names.
// Headers are normalized first (lowercased, punctuation/whitespace collapsed
// to underscores) so "Senior. Social Worker" and "Case load" both resolve
// without needing exact snake_case from whoever prepares the file.
const HEADER_ALIASES = {
  centre_id: "centre_id",
  centre_type: "centre_type",
  case_load: "caseload",
  senior_social_worker: "senior_social_workers",
  social_worker: "social_workers",
  programme_assistant: "programme_assistants",
  co_funding: "co_funding",
  license_status: "license_status",
  effective_period: "effective_period", // e.g. "2026-Q3" — which quarter this row applies to
};

function normalizeHeader(h) {
  return String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const REQUIRED = ["centre_id", "centre_type", "caseload", "license_status", "effective_period"];

// The natural key for a grant computation is (centre, quarter) — NOT
// (upload, row). Two uploads/entries for the same centre + effective
// period are the same logical fact, so this key doubling as the DB's
// idempotency_key means a re-submission naturally UPDATES the existing
// row (see the ON CONFLICT below) instead of creating a duplicate — this
// is what "don't accept duplicate entries for a centre in the same
// effective period" resolves to at the data layer.
function naturalKey(data, fallbackUploadId, fallbackRowNumber) {
  return data.centre_id && data.effective_period
    ? `${data.centre_id}:${data.effective_period}`
    : `${fallbackUploadId}:${fallbackRowNumber}`; // malformed row, missing one of the key fields
}

function toStaffArray(data) {
  const roleCounts = {
    "Senior Social Worker": Number(data.senior_social_workers || 0),
    "Social Worker": Number(data.social_workers || 0),
    "Programme Assistant": Number(data.programme_assistants || 0),
  };
  return Object.entries(roleCounts).flatMap(([role, count]) =>
    Array.from({ length: count }, () => ({ role, qualified: true, onPayrollFullQuarter: true }))
  );
}

function toCentre(data) {
  return {
    centreType: String(data.centre_type).trim().toLowerCase(),
    caseload: Number(data.caseload),
    licenceActiveFullQuarter: /^active$/i.test(String(data.license_status || "").trim()),
    coFunding: Number(data.co_funding || 0),
    staff: toStaffArray(data),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded concurrency in ~8 lines — no library needed for this shape.
async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function submitWithRetry(row) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await decisionApi.post(
        "/v1/decisions",
        { centre: toCentre(row.data), effectivePeriod: row.data.effective_period, centreId: row.data.centre_id },
        { headers: { "Idempotency-Key": row.idempotency_key } }
      );
      return data;
    } catch (err) {
      const status = err.response?.status;
      if (status >= 400 && status < 500) throw err; // don't retry client errors
      if (attempt === 3) throw err;
      await sleep(300 * 2 ** attempt); // 600ms, 1200ms
    }
  }
}

async function processRow(row) {
  try {
    const decision = await submitWithRetry(row);
    await db.query(
      `UPDATE upload_rows SET status = 'succeeded', decision = $2 WHERE id = $1`,
      [row.id, decision]
    );
  } catch (err) {
    await db.query(
      `UPDATE upload_rows SET status = 'failed', error = $2 WHERE id = $1`,
      [row.id, err.message]
    );
  }
}

async function claimNextUpload() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM uploads WHERE status = 'pending'
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!rows[0]) { await client.query("COMMIT"); return null; }
    await client.query(`UPDATE uploads SET status = 'processing' WHERE id = $1`, [rows[0].id]);
    await client.query("COMMIT");
    return rows[0];
  } finally {
    client.release();
  }
}

async function processUpload(upload) {
  if (upload.source === "file") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(upload.file_path);
    const sheet = wb.worksheets[0];

    const headers = [];
    sheet.getRow(1).eachCell((cell, col) => {
      const normalized = normalizeHeader(cell.value);
      headers[col] = HEADER_ALIASES[normalized] || normalized;
    });

    const parsed = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const data = {};
      row.eachCell((cell, col) => (data[headers[col]] = cell.value));
      if (Object.keys(data).length) parsed.push({ rowNumber, data });
    });

    for (const r of parsed) {
      const missing = REQUIRED.filter((f) => !r.data[f]);
      await db.query(
        `INSERT INTO upload_rows (upload_id, row_number, data, status, error, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           upload_id = EXCLUDED.upload_id, row_number = EXCLUDED.row_number,
           data = EXCLUDED.data, status = EXCLUDED.status, error = EXCLUDED.error,
           decision = NULL`, // force recomputation — see naturalKey() above
        [
          upload.id, r.rowNumber, r.data,
          missing.length ? "failed" : "pending",
          missing.length ? `missing: ${missing.join(", ")}` : null,
          naturalKey(r.data, upload.id, r.rowNumber),
        ]
      );
    }
  }
  // source === 'manual': the row was already inserted by POST /centres —
  // nothing to parse, fall straight through to submission below.

  const { rows: pending } = await db.query(
    `SELECT * FROM upload_rows WHERE upload_id = $1 AND status = 'pending'`, [upload.id]
  );
  await pool(pending, 5, processRow);

  const { rows: [counts] } = await db.query(
    `SELECT count(*) FILTER (WHERE status='succeeded') AS ok,
            count(*) FILTER (WHERE status='failed') AS bad,
            count(*) AS total
     FROM upload_rows WHERE upload_id = $1`, [upload.id]
  );
  const status = counts.bad == 0 ? "complete" : counts.ok == 0 ? "failed" : "partial";
  await db.query(
    `UPDATE uploads SET status=$2, total_rows=$3, processed_rows=$4, failed_rows=$5 WHERE id=$1`,
    [upload.id, status, counts.total, counts.ok, counts.bad]
  );
  console.log(`upload ${upload.id}: ${status} (${counts.ok}/${counts.total})`);
}

async function loop() {
  const upload = await claimNextUpload();
  if (upload) {
    try { await processUpload(upload); }
    catch (err) {
      console.error(`upload ${upload.id} crashed:`, err.message);
      await db.query(`UPDATE uploads SET status='failed', error=$2 WHERE id=$1`, [upload.id, err.message]);
    }
  }
  setTimeout(loop, upload ? 200 : 2000); // tighten polling while there's a backlog
}

console.log("worker up");

// Same idempotent migration as backend/server.js — the worker also reads
// upload.source, so it needs the column to exist regardless of which
// service happens to start (and migrate) first.
async function migrate() {
  await db.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'file'`);
  await db.query(`ALTER TABLE uploads ALTER COLUMN file_path DROP NOT NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_upload_rows_centre_period ON upload_rows ((data->>'centre_id'), (data->>'effective_period'))`);
}

migrate()
  .then(loop)
  .catch((err) => {
    console.error("startup migration failed:", err.message);
    process.exit(1);
  });
