import express from "express";
import multer from "multer";
import crypto from "crypto";
import pg from "pg";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

// --- CORS: frontend (5173) and backend (3000) are different origins, and
// the Authorization header makes every request preflighted. Must run
// BEFORE the auth check below, since preflight OPTIONS requests never
// carry Authorization and would otherwise get a 401. ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- auth: single shared bearer token for this exercise. Real system:
// IdP-issued JWT verified per officer (RBAC left out, see README). ---
app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks") || req.path === "/healthz") return next();
  if (req.header("Authorization") !== `Bearer ${process.env.API_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// --- upload: file saved to a volume shared with the worker. Real system:
// S3/object storage, not a local disk mount (left out — see README). ---
const upload = multer({
  storage: multer.diskStorage({
    destination: "/uploads",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, /\.xlsx?$/i.test(file.originalname)),
});

app.post("/uploads", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "attach an .xlsx as 'file'" });
  const { rows } = await db.query(
    `INSERT INTO uploads (filename, file_path, source) VALUES ($1, $2, 'file') RETURNING id`,
    [req.file.originalname, req.file.path]
  );
  res.status(202).json({ uploadId: rows[0].id, status: "pending" });
});

app.get("/uploads/:id", async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM uploads WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// Shapes a raw upload_rows record (+ its computed decision) into the flat
// columns the frontend table expects. Split amounts are looked up by party
// name from scheme.json's funding split — see grant-computation/scheme.json.
// "status" here is the GRANT outcome (Accepted/Rejected), not the async
// processing status — a row still mid-flight shows its processing state
// instead, since there's no grant outcome to report yet.
function shapeRow(r) {
  const split = r.decision?.split || [];
  const amountFor = (party) => split.find((s) => s.party === party)?.amount ?? null;
  const status =
    r.decision?.decision === "approved" ? "Grant Accepted" :
    r.decision?.decision === "rejected" ? "Grant Rejected" :
    r.status === "failed" ? "Failed" :
    r.status === "succeeded" ? "Grant Accepted" :
    "Processing";
  return {
    rowNumber: r.row_number,
    centreId: r.centre_id,
    centreName: r.centre_name,
    effectivePeriod: r.effective_period,
    status,
    sanctionedGrant: r.decision?.netGrant ?? null,
    ministry: amountFor("Ministry"),
    communityChest: amountFor("Community Chest"),
    townCouncil: amountFor("Town Council Social Support"),
    error: r.error,
    ...(r.upload_id ? { uploadId: r.upload_id, uploadedAt: r.created_at } : {}),
  };
}

app.get("/uploads/:id/rows", async (req, res) => {
  const { rows } = await db.query(
    `SELECT row_number, data->>'centre_id' AS centre_id, data->>'centre_name' AS centre_name,
            data->>'effective_period' AS effective_period, status, decision, error
     FROM upload_rows WHERE upload_id = $1 ORDER BY row_number`,
    [req.params.id]
  );
  res.json(rows.map(shapeRow));
});

// Same natural-key logic as worker/index.js's naturalKey() — deterministic
// per (centre, quarter) so ON CONFLICT (idempotency_key) upserts instead of
// duplicating. Small enough to duplicate rather than share a package across
// two otherwise-independent services (see README, "Problem 2 ↔ Problem 3").
function naturalKey(centreId, effectivePeriod, fallback) {
  return centreId && effectivePeriod ? `${centreId}:${effectivePeriod}` : fallback;
}

// Single-row manual entry — same downstream path as a bulk upload (an
// 'uploads' record + one 'upload_rows' record for the worker to pick up),
// just with source='manual' so the worker skips the file-parsing step.
const CENTRE_FIELDS = ["centreId", "centreType", "caseload", "licenseStatus", "effectivePeriod"];

app.post("/centres", express.json(), async (req, res) => {
  const c = req.body || {};
  const missing = CENTRE_FIELDS.filter((f) => !c[f]);
  if (missing.length) return res.status(400).json({ error: `missing: ${missing.join(", ")}` });

  const data = {
    centre_id: c.centreId,
    centre_name: c.centreName || null,
    centre_type: c.centreType,
    caseload: c.caseload,
    license_status: c.licenseStatus,
    effective_period: c.effectivePeriod,
    senior_social_workers: c.seniorSocialWorkers || 0,
    social_workers: c.socialWorkers || 0,
    programme_assistants: c.programmeAssistants || 0,
    co_funding: c.coFunding || 0,
  };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO uploads (filename, source) VALUES ($1, 'manual') RETURNING id`,
      [`manual entry — ${c.centreId} (${c.effectivePeriod})`]
    );
    const uploadId = rows[0].id;
    await client.query(
      `INSERT INTO upload_rows (upload_id, row_number, data, idempotency_key)
       VALUES ($1, 1, $2, $3)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         upload_id = EXCLUDED.upload_id, row_number = EXCLUDED.row_number,
         data = EXCLUDED.data, status = 'pending', error = NULL, decision = NULL`,
      [uploadId, data, naturalKey(c.centreId, c.effectivePeriod, `${uploadId}:1`)]
    );
    await client.query("COMMIT");
    res.status(202).json({ uploadId, status: "pending" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Search by Centre ID(s) and/or Centre Name(s) (OR'd together — either
// identifies a centre) and/or Effective period. '*' on any field means
// "match all" for that axis, so "ids=*&period=2026-Q3" is "every centre
// for Q3" and "ids=*&period=*" is everything.
app.get("/centres", async (req, res) => {
  const idsParam = (req.query.ids || "").trim();
  const namesParam = (req.query.names || "").trim();
  const periodParam = (req.query.period || "").trim();

  if (!idsParam && !namesParam && !periodParam) {
    return res.status(400).json({ error: "provide ids, names, and/or period ('*' matches all)" });
  }

  const conditions = [];
  const params = [];
  const centreConditions = [];

  if (idsParam && idsParam !== "*") {
    params.push(idsParam.split(",").map((s) => s.trim()).filter(Boolean));
    centreConditions.push(`ur.data->>'centre_id' = ANY($${params.length})`);
  }
  if (namesParam && namesParam !== "*") {
    params.push(namesParam.split(",").map((s) => s.trim()).filter(Boolean));
    centreConditions.push(`ur.data->>'centre_name' = ANY($${params.length})`);
  }
  if (centreConditions.length) conditions.push(`(${centreConditions.join(" OR ")})`);

  if (periodParam && periodParam !== "*") {
    params.push(periodParam);
    conditions.push(`ur.data->>'effective_period' = $${params.length}`);
  }

  const where = conditions.length ? conditions.join(" AND ") : "true";
  const { rows } = await db.query(
    `SELECT ur.row_number, ur.data->>'centre_id' AS centre_id, ur.data->>'centre_name' AS centre_name,
            ur.data->>'effective_period' AS effective_period, ur.status, ur.decision, ur.error,
            u.id AS upload_id, u.created_at
     FROM upload_rows ur JOIN uploads u ON u.id = ur.upload_id
     WHERE ${where}
     ORDER BY u.created_at DESC`,
    params
  );
  res.json(rows.map(shapeRow));
});

// --- inbound webhook: async decision-service callback. Protected by HMAC
// signature, not the bearer-token auth above (caller is a machine). ---
app.post("/webhooks/decision", express.raw({ type: "*/*" }), async (req, res) => {
  const expected = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(req.body).digest("hex");
  const given = (req.header("X-Signature") || "").replace(/^sha256=/, "");
  const a = Buffer.from(given, "hex"), b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "bad signature" });
  }

  const { idempotencyKey, decision } = JSON.parse(req.body.toString());
  // Idempotent: a row already succeeded ignores a redelivered callback.
  await db.query(
    `UPDATE upload_rows SET status = 'succeeded', decision = $2
     WHERE idempotency_key = $1 AND status != 'succeeded'`,
    [idempotencyKey, decision]
  );
  res.json({ received: true });
});

// --- startup migration: idempotent, self-healing. A real system uses a
// versioned migration tool (Flyway/node-pg-migrate); this repo doesn't
// (see README, "cuts" table) — this is the minimum needed so a schema
// change picks itself up without requiring `docker compose down -v` and
// losing local data every time. Safe to run on every restart. ---
async function migrate() {
  await db.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'file'`);
  await db.query(`ALTER TABLE uploads ALTER COLUMN file_path DROP NOT NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_upload_rows_centre_period ON upload_rows ((data->>'centre_id'), (data->>'effective_period'))`);
}

migrate()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log("backend up (migrated)")))
  .catch((err) => {
    console.error("startup migration failed:", err.message);
    process.exit(1);
  });
