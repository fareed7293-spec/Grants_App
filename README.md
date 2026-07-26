# Grant Computation Orchestrator

Take-home assessment submission — Software Engineer, Platform Engineering & System Orchestration.

## Run it

```bash
docker compose up --build
```

- Frontend: http://localhost:5173
- Backend health check: http://localhost:3000/healthz

Upload columns (see `sample_centres_upload.xlsx`): `Centre Name, Centre ID,
Centre type, Case load, Senior. Social Worker, Social Worker,
Programme  Assistant, Co-funding, License status, Effective period`.
`sample_centres_upload_v2_upsert_demo.xlsx` re-submits the same Centre ID +
Effective period with a corrected figure, to demonstrate the upsert
behavior described below.

```bash
cd grant-computation && npm test && npm start
```

## Problem 1 — Infrastructure Design & CI/CD
- **Task 1A** (network segmentation, secrets, webhook exposure, egress IP
  stability, environments): `docs/architecture.md`
- **Task 1B** (pipeline stages, quality gates, traceability, approval gate,
  the safeguard I consider essential for a government production system):
  `.gitlab-ci.yml`

## Problem 2 — System Integration & Orchestration

**Idempotency strategy.** `(Centre ID, Effective period)` is the natural
key for a grant computation — see `naturalKey()` in `worker/index.js`. It
deterministically derives `idempotency_key`, so re-submitting the same
centre+quarter (file upload or the single-entry form) upserts the existing
row (`ON CONFLICT (idempotency_key) DO UPDATE`, decision reset to force
recomputation) instead of duplicating it. The decision service's own
idempotency cache keys on `(Idempotency-Key, payload hash)`, so a true
network retry still replays safely while a genuine data correction under
the same key triggers a fresh computation.

**Limitations.** Assumes the real decision service honors an
idempotency-key header the way the mock does — needs confirming against
the actual provider, not assumed. No dead-letter/re-drive path for a row
that exhausts retries; it just sits as `Failed`.

**Before running against a real system:** confirm the real provider's
idempotency contract, replace the shared bearer token with real IdP auth,
add a dead-letter re-drive endpoint, load-test the worker's concurrency
setting against the provider's actual rate limits, reinstate a circuit
breaker around the decision-service client.

**Deliberately left out** (each a real simplification, documented rather
than hidden): a message broker (Postgres `SKIP LOCKED` instead), S3/object
storage (a shared Docker volume instead), a frontend build step (React via
CDN, single HTML file instead), per-officer RBAC (one shared bearer token
instead), and the IaC to actually provision `docs/architecture.md`'s
topology.

## Problem 3 — Grant Computation
See `grant-computation/README.md` for Scenario 1's result, Scenario 2's
extensibility, and both discussion sections.

The same rate-versioning logic also drives the running app:
`mock-decision-service/calculator.js` is a deliberate **copy** of
`grant-computation/calculator.js`, not a shared import — in production this
logic lives on Opus, a separate platform the orchestrator only calls, so
duplicating it here keeps that boundary honest instead of coupling two
services that wouldn't share code in production.

## API summary
- `POST /uploads` — bulk `.xlsx` upload
- `POST /centres` — single-centre entry, same downstream pipeline
- `GET /uploads/:id`, `GET /uploads/:id/rows` — batch status and results
- `GET /centres?ids=...&names=...&period=...` — search by Centre ID(s)
  and/or Centre Name(s) (OR'd together), and/or Effective period; `*` on
  any field matches all values for that field
- `POST /webhooks/decision` — signed async callback from the decision
  service

## AI assistant usage

Built with Claude generating scaffolding for each file. 
I directed the architectural decisions (idempotency key shape, network segmentation, the CI/CD safeguard, the rate-versioning approach, the Discussion 1
ambiguities) and verified the grant-computation arithmetic myself via the
test suite rather than trusting generated numbers. I reviewed each proposed
design against those requirements and directed changes where it didn't
fit. 

I can walk through the reasoning behind any specific choice in this repo —
the idempotency key shape, the network segmentation, the CI/CD safeguard,
or the Discussion 1/2 answers — in the interview.