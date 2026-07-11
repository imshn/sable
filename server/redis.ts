// Redis (Upstash) — the async/high-speed layer. Turso stays the source of
// truth; everything here degrades to the pre-Redis behavior when REDIS_URL
// is absent.
//
// Deliberate scope on a single instance (see PHASE5.md): Redis backs the
// BullMQ queues and health checks. Hot-path caches and rate-limit counters
// stay in-memory — with one instance they're already correct, and the
// Upstash region (ap-south-1) is a ~250ms round trip from Render, which
// would make every packet slower for zero consistency gain. Set
// REDIS_SCALE_OUT=1 when running multiple instances to flip the Socket.IO
// adapter + shared counters on.
import { Redis } from 'ioredis'
import { env } from './config.js'
import { log } from './log.js'

export const redisEnabled = !!env.REDIS_URL

// BullMQ requires maxRetriesPerRequest: null (long-blocking commands).
export function makeRedis(): Redis {
  const r = new Redis(env.REDIS_URL!, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectTimeout: 10_000,
  })
  r.on('error', (e) => log.app.warn({ err: e.message }, 'redis error'))
  return r
}

// One shared connection for health checks and ad-hoc commands. BullMQ
// queues/workers create their own (blocking commands can't share).
export const redis: Redis | null = redisEnabled ? makeRedis() : null

export async function redisHealth(): Promise<'healthy' | 'offline' | 'not_configured'> {
  if (!redis) return 'not_configured'
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ])
    return 'healthy'
  } catch {
    return 'offline'
  }
}
