import express from "express";
import crypto from "crypto";
import { readFileSync } from "fs";
import { computeGrant, resolveRates, quarterStartFromPeriod } from "./calculator.js";

const app = express();
app.use(express.json());

const scheme = JSON.parse(readFileSync(new URL("./scheme.json", import.meta.url)));
const rateTable = JSON.parse(readFileSync(new URL("./rates.json", import.meta.url)));

// Stands in for Opus in this exercise — the platform that would actually
// own grant business rules in production (see JD: "Business rules... built
// primarily on Opus, GovTech's workflow and rules platform"). Our system
// only orchestrates: sends a case, gets a decision back.
//
// Idempotency-Key here is deterministic per (centre, quarter) — see
// naturalKey() in worker/index.js — NOT per individual submission attempt.
// That means the same key legitimately arrives twice for two different
// reasons: (a) a genuine network retry of the exact same request, which
// MUST replay the cached response, or (b) a corrected re-entry for the
// same centre+quarter (the whole point of the upsert in Problem 2, item 2),
// which MUST recompute. Keying the cache on (Idempotency-Key + payload
// hash) tells these apart: identical payload -> replay; different payload
// under the same key -> treat as a new logical submission.
const seen = new Map(); // Idempotency-Key -> { payloadHash, response }

app.post("/v1/decisions", (req, res) => {
  const key = req.header("Idempotency-Key");
  if (!key) return res.status(400).json({ error: "Idempotency-Key required" });

  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
  const cached = seen.get(key);
  if (cached && cached.payloadHash === payloadHash) return res.json(cached.response);

  const { centre, effectivePeriod } = req.body;
  try {
    const quarterStart = quarterStartFromPeriod(effectivePeriod);
    const rates = resolveRates(rateTable, quarterStart);
    const result = computeGrant(scheme, rates, centre);
    const response = { decision: result.eligible ? "approved" : "rejected", effectivePeriod, ...result };
    seen.set(key, { payloadHash, response });
    res.json(response);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

app.listen(4000, () => console.log("mock decision service (grant computation) up"));
