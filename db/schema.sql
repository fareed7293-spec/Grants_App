CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  file_path TEXT, -- null for source='manual' (single-row entries have no file)
  source TEXT NOT NULL DEFAULT 'file', -- 'file' | 'manual'
  status TEXT NOT NULL DEFAULT 'pending', -- pending -> processing -> complete|partial|failed
  total_rows INT,
  processed_rows INT NOT NULL DEFAULT 0,
  failed_rows INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE upload_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  data JSONB NOT NULL, -- includes centre_id, effective_period ('YYYY-Qn', e.g. '2026-Q3')
  status TEXT NOT NULL DEFAULT 'pending', -- pending -> succeeded|failed
  decision JSONB,
  error TEXT,
  -- Sent to the decision service as Idempotency-Key. Deterministically
  -- derived from (centre_id, effective_period) — see naturalKey() in
  -- worker/index.js — so ON CONFLICT (idempotency_key) IS the upsert:
  -- resubmitting the same centre+quarter updates the existing row instead
  -- of creating a duplicate, satisfying "no duplicate centre+period rows."
  idempotency_key TEXT NOT NULL UNIQUE,
  UNIQUE (upload_id, row_number)
);

-- Indexes the JSONB paths directly rather than duplicating them into real
-- columns — one less place for centre_id/effective_period to go stale.
CREATE INDEX idx_upload_rows_centre_period ON upload_rows ((data->>'centre_id'), (data->>'effective_period'));
