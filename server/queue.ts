// BullMQ queues — only for work that genuinely benefits from queuing:
// push notifications (retry/backoff/DLQ per device), audit writes
// (durability without blocking the caller), and cleanup (scheduled).
// Live chat traffic — messages, typing, presence, read receipts — never
// touches a queue; those stay on the real-time socket path.
//
// Two queues, not nine: 'push' gets its own (different retry profile,
// user-facing latency), everything else is named jobs on 'system'. Workers
// run in-process by default; server/worker.ts is the standalone entrypoint
// for the day this moves to a dedicated Render background worker. Jobs
// persist in Redis either way, so an API restart never loses queued work.
//
// Everything degrades: with no REDIS_URL every enqueue helper falls back
// to the direct call it replaced.
import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import { redis, redisEnabled, makeRedis } from './redis.js'
import { deliverPush } from './push.js'
import { store } from './db.js'
import { log } from './log.js'
import type { PushSubscriptionRow, PushPayload } from './types.js'

const defaultJobOptions = {
  attempts: 4,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { age: 3600, count: 500 },
  // the failed set IS the dead-letter queue — kept a week for inspection
  removeOnFail: { age: 7 * 86_400, count: 2000 },
}

const connection = redis as ConnectionOptions | null

export const pushQueue = connection ? new Queue('push', { connection, defaultJobOptions }) : null
export const systemQueue = connection ? new Queue('system', { connection, defaultJobOptions }) : null

interface PushJob { sub: PushSubscriptionRow; payload: PushPayload; userId: string }
interface AuditJob {
  kind: 'admin' | 'security'
  id: string
  a: string // action/event
  b: string | null // target/userId's counterpart
  detail: string | null
  ip: string | null
}

// ---- enqueue helpers (each with a direct-call fallback) ----

export function enqueuePush(sub: PushSubscriptionRow, payload: PushPayload, userId: string): void {
  if (pushQueue) {
    // a ringing call is the only push where seconds matter
    const priority = payload.kind === 'call-ringing' ? 1 : 3
    pushQueue.add('deliver', { sub, payload, userId } satisfies PushJob, { priority })
      .catch((e) => { log.worker.warn({ err: e.message }, 'enqueue failed, delivering directly'); deliverPush(sub, payload, userId).catch(() => {}) })
  } else {
    deliverPush(sub, payload, userId).catch(() => {})
  }
}

export function enqueueAdminAudit(id: string, action: string, target: string | null, detail: string | null, ip: string | null): void {
  if (systemQueue) {
    systemQueue.add('audit', { kind: 'admin', id, a: action, b: target, detail, ip } satisfies AuditJob)
      .catch(() => store.logAdminAction(id, action, target, detail, ip))
  } else {
    store.logAdminAction(id, action, target, detail, ip)
  }
}

export function enqueueSecurityAudit(id: string, userId: string, event: string, detail: string | null, ip: string | null): void {
  if (systemQueue) {
    systemQueue.add('audit', { kind: 'security', id, a: event, b: userId, detail, ip } satisfies AuditJob)
      .catch(() => store.logSecurityEvent(id, userId, event, detail, ip))
  } else {
    store.logSecurityEvent(id, userId, event, detail, ip)
  }
}

// ---- workers ----

export function startWorkers(): void {
  if (!redisEnabled) return

  // drainDelay 60s: when idle the blocking poll wakes ~1/min (Upstash free
  // tier bills per command), but a new job still wakes it instantly — the
  // blocking read returns as soon as the marker key gets data.
  const workerOpts = { connection: makeRedis() as ConnectionOptions, drainDelay: 60 }

  const pushWorker = new Worker<PushJob>('push', async (job) => {
    await deliverPush(job.data.sub, job.data.payload, job.data.userId)
  }, { ...workerOpts, concurrency: 5 })

  const systemWorker = new Worker<AuditJob>('system', async (job) => {
    if (job.name === 'audit') {
      const { kind, id, a, b, detail, ip } = job.data
      if (kind === 'admin') await store.logAdminAction(id, a, b, detail, ip)
      else await store.logSecurityEvent(id, b!, a, detail, ip)
      return
    }
    if (job.name === 'cleanup') {
      const counts = await store.runCleanup()
      log.worker.info(counts, 'cleanup done')
    }
  }, workerOpts)

  for (const w of [pushWorker, systemWorker]) {
    w.on('failed', (job, err) => log.worker.warn({ queue: w.name, job: job?.name, attempts: job?.attemptsMade, err: err.message }, 'job failed'))
    w.on('error', (err) => log.worker.error({ queue: w.name, err: err.message }, 'worker error'))
  }
  log.worker.info('queue workers started (in-process)')
}

export async function scheduleMaintenance(): Promise<void> {
  if (!systemQueue) return
  // upsert = idempotent across restarts; every 6h is plenty for log pruning
  await systemQueue.upsertJobScheduler('cleanup-6h', { every: 6 * 3_600_000 }, { name: 'cleanup' })
}

export async function queueStats(): Promise<Record<string, Record<string, number>> | null> {
  if (!pushQueue || !systemQueue) return null
  try {
    const [p, s] = await Promise.all([
      pushQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      systemQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
    ])
    return { push: p, system: s }
  } catch {
    return null
  }
}
