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

## Batch 2 (pending `REDIS_URL` — Upstash free tier)

Gated entirely on the env var being present; without it everything runs
exactly as batch 1:

1. Redis-backed `CounterStore` (rate limits shared across instances).
2. Cache layer for profiles/contacts/privacy/flags with TTL + write-through
   invalidation.
3. `@socket.io/redis-adapter` — multi-instance compatible, not clustered.
4. BullMQ: `push` queue (retry/backoff/DLQ/priorities) + `maintenance`
   queue (expired invites, stale sessions, old failed-login rows). Workers
   run in-process behind a separate entrypoint so they can move to a Render
   background worker without code changes.
5. Queue depth/failures + Redis health wired into the admin dashboard.

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
