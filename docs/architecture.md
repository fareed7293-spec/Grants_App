# Architecture — Task 1A

## Sequenced: data model & async contract first, network second, CI/CD third
Getting the row/queue contract wrong is expensive to unwind; network topology
constrains where the worker can run at all (egress IP); CI/CD is mechanical
once the shape of the system is settled. Full IaC, real IdP, and Kubernetes
manifests are described below but not written out — see root README, "left
out" section.

## Network segmentation
```
 Internet → [ALB / API Gateway + WAF]  (only public thing)
                    │
      ┌─────────────┼──────────────┐
      ▼                             ▼
 [Backend API]                [Worker]
 private subnet, no           private subnet, NO inbound
 public IP                    listener at all in prod
      │                             │
      ▼                             ▼
 [Postgres]                  [NAT Gateway, fixed IP]
 private, no public IP              │
                                     ▼
                          [External decision service]
                          allowlist = NAT Gateway IP
```
Backend, worker, and Postgres all sit in private subnets. The worker has no
HTTP listener in production — it only pulls work and makes outbound calls,
so there's no inbound attack surface to secure on that service at all.

## Secrets
Pulled from a managed secrets store (Secrets Manager / Vault) at container
start via IAM role — never baked into images or committed as plain env vars.
Scoped per service: only the worker holds the decision-service API key; the
backend (more exposed, public-facing) never sees it. This repo's
`docker-compose.yml` uses plaintext dev values (`dev-token`, `dev-key`) —
fine for local, never for anything else.

## Inbound webhook
`POST /webhooks/decision` is the one inbound path from outside into the
system beyond the officer-facing API. It's protected by HMAC-SHA256
signature verification (raw body, constant-time compare — see
`backend/server.js`), not by the officer bearer-token check, since the
caller is a machine. It's idempotent: a callback for an already-`succeeded`
row is acknowledged but not reprocessed, since providers commonly retry
until they see a fast 2xx.

## Outbound calls & egress IP stability
Only the worker calls the decision service, from a subnet whose *egress*
traffic routes through a NAT Gateway with a fixed IP. That IP — not any
individual container's IP — is what's registered on the decision service's
allowlist, so scaling the worker or redeploying it doesn't break the
allowlist entry.

## Environments
Dev/staging/production are separate VPCs, databases, and secrets — critically,
separate decision-service credentials, so a staging bug can never submit a
real case to the live decision engine. Dev is this repo's `docker-compose.yml`
with the mock decision service standing in for the real one.
