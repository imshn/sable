# Phase 5 — Backend Infrastructure, Performance & Security

Goal: production-ready backend for the existing single-process Express +
Socket.IO relay. No new user features. Turso stays the source of truth.

## Architectural decisions

**Modular monolith, not services.** The backend keeps its existing shape —
`sockets/*` domain modules (controllers), `db.ts` (repository), `notify.ts`/
`push.ts` (services), `flags.ts`/`config.ts` (configuration), `guard.ts`/
`rateLimit.ts` (boundary middleware). No microservices, no k8s.

**Boundary-first security.** Every inbound socket packet passes through one
per-packet middleware (`guard.ts: packetGuard`) that rate-limits then
Zod-validates before any handler runs. Handlers keep domain rules (contact
status, privacy, flags); the boundary stops abuse. HTTP has the twin
(`httpLimit` + helmet + strict CORS allowlist + 256kb body cap + compression
+ `trust proxy` for real client IPs behind Render).

**Two-window rate limiting.** Each rule has a sustained window (generous —
real users never hit it) and a short burst window (what actually stops
floods). Counters live behind a one-method `CounterStore` interface
(`incr(key, windowMs)`) — in-memory today, Redis `INCR`+`PEXPIRE` in batch 2
with zero call-site changes. Rejected packets are dropped and the client
gets a standard `rate-limited` / `invalid-request` event.

**Centralized errors, zero handler rewrites.** `wrapSocketErrors` patches
`socket.on` at connection time so every listener (sync or async) reports
failures to structured logging instead of dying as an unhandledRejection.
Express 5 forwards rejected async handlers to the single `errorHandler`
middleware. Internals never leak — clients get generic shapes.

**Typed config, fail-fast.** `config.ts` is the only place `process.env` is
read. Zod-validated at boot; malformed values or half-configured pairs
(e.g. one of two push keys) exit with a precise message. *Absent* optional
features still degrade gracefully (no Turso = memory-only), matching prior
behavior.

**Structured logging.** pino, one child logger per category
(`app/api/socket/security/audit/worker`), JSON to stdout (Render captures
it). No message payloads, keys, tokens, or endpoints are ever logged.

**Audit trail.** `security_events` table (user-level: passkey changes,
privacy changes, profile updates, session revocations, account deletion)
— separate from `admin_audit_log` (admin actions) and from application
logs, queryable per user.

**Idempotency (verified, mostly pre-existing).** Messages dedupe by
`(id, recipient)` primary key with client-generated ids; contact requests
are `ON CONFLICT DO UPDATE`; ICE-restart call offers are excluded from call
logging by the `restart` flag.

**Honest omissions.** No email queue (no email service exists), no media
processing queues (E2E encryption — the server never sees media), no OTP
storage (passwordless + passkeys, no OTP flow). These come back only when
the underlying feature does.

## Performance pass

- `getContactPair(a, b)` single-row lookup replaced fetch-all-contacts-and-
  filter on every dm/call/typing packet.
- Bulk privacy-settings fetch (one `IN (...)` query per contact-list load
  instead of one query per contact), with default-row caching so users with
  no settings row don't re-query.
- New indexes on the measured hot paths: `contacts(recipient_id)`,
  `failed_logins(ip, ts)` (every hello), `call_logs(caller, callee, ts)`
  (every call event), `call_logs(group_id, ts)`, `messages(sender)`,
  `invitations(creator_id)`.

## Batch 2 — Redis + BullMQ (implemented, gated on `REDIS_URL`)

Upstash free tier (ap-south-1). Without the env var everything degrades to
batch-1 behavior; with it:

1. **BullMQ, two queues.** `push`: one job per device, priority (ringing
   call = 1), 4 attempts with exponential backoff, failed set = DLQ kept a
   week. `system`: named jobs — `audit` (admin + user security events,
   durable without blocking the caller) and `cleanup` (6-hourly scheduler,
   prunes failed_logins >30d, push_log >90d, revoked sessions >90d).
   Expired invites are deliberately kept so invite analytics stay honest;
   audit tables are kept forever. Live traffic (messages, typing, presence,
   receipts) never touches a queue.
2. **Workers**: in-process by default; jobs persist in Redis so restarts
   lose nothing. `server/worker.ts` is the standalone entrypoint for a
   future dedicated Render worker (start-command change only). Idle
   blocking polls run at 60s (Upstash bills per command) but a new job
   still wakes a worker instantly.
3. **Scale-out mode** (`REDIS_SCALE_OUT=1`, default off): Socket.IO Redis
   adapter + shared Redis rate-limit counters (fail-open). Off on a single
   instance because the Mumbai↔Oregon round trip (~250ms) would tax every
   broadcast/packet for zero consistency gain — this is also why hot-path
   caches stay in-memory rather than in Redis for now.
4. **Monitoring**: real Redis PING health in the dashboard (Redis down can
   only drag overall health to "warning" since everything falls back to
   direct calls) + live per-queue pending/failed(DLQ)/completed counts.
5. **Analytics aggregation deferred**: admin stats run live against indexed
   queries; a daily rollup table adds value only when raw-table scans get
   slow. Revisit at real scale.

## Migration guide

- **New env vars (all optional):** `CORS_ORIGINS` (comma-separated
  allowlist; `*` wildcards allowed; defaults cover prod + previews +
  localhost), `LOG_LEVEL` (default `info`), `REDIS_URL` (enables batch 2).
- **Behavior changes:** CORS is now an allowlist (was: reflect any origin).
  Unknown origins get no CORS headers. Flooding clients get packets dropped
  with a `rate-limited` event; malformed payloads get `invalid-request`.
  Logs are JSON (pino) instead of plain text.
- **DB:** migration adds `security_events` + six indexes, all
  `IF NOT EXISTS` — safe to re-run, no data changes.
