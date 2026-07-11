// Rate limiting + burst protection + abuse cooldowns, one module.
//
// Two windows per rule: a sustained window (rate) and a short burst window
// (spike protection) — a client must pass BOTH. Example: messages allow
// 600/min sustained, but never more than 25 in any 2-second burst, so a
// paste-bomb loop trips instantly even though it's under the per-minute cap.
//
// The counter store is a tiny interface (incr-with-expiry) implemented
// in-memory today. Batch 2 swaps in a Redis INCR/PEXPIRE implementation
// behind the same interface — no call sites change.

export interface CounterStore {
  // Increment `key`, setting it to expire windowMs from its FIRST increment.
  // Returns the post-increment count within the current window.
  incr(key: string, windowMs: number): Promise<number>
}

class MemoryCounterStore implements CounterStore {
  private counters = new Map<string, { count: number; resetAt: number }>()

  async incr(key: string, windowMs: number): Promise<number> {
    const now = Date.now()
    const c = this.counters.get(key)
    if (!c || c.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + windowMs })
      return 1
    }
    return ++c.count
  }

  // ponytail: periodic sweep instead of per-key timers — thousands of keys
  // cost one pass every 5 minutes, not thousands of setTimeouts.
  sweep(): void {
    const now = Date.now()
    for (const [k, v] of this.counters) if (v.resetAt <= now) this.counters.delete(k)
  }
}

const memoryStore = new MemoryCounterStore()
setInterval(() => memoryStore.sweep(), 300_000).unref()

let activeStore: CounterStore = memoryStore
export function setCounterStore(store: CounterStore): void {
  activeStore = store
}

// Redis-backed counters for multi-instance deployments (REDIS_SCALE_OUT=1)
// — INCR + first-hit PEXPIRE gives the same fixed-window semantics as the
// memory store, shared across every instance. Fails open: if Redis errors,
// traffic is allowed rather than blocking real users on infra hiccups.
export class RedisCounterStore implements CounterStore {
  constructor(private r: { incr(key: string): Promise<number>; pexpire(key: string, ms: number): Promise<number> }) {}
  async incr(key: string, windowMs: number): Promise<number> {
    try {
      const n = await this.r.incr(key)
      if (n === 1) await this.r.pexpire(key, windowMs)
      return n
    } catch {
      return 0 // fail open
    }
  }
}

export interface LimitRule {
  // sustained window
  max: number
  windowMs: number
  // burst window (short spike) — optional
  burstMax?: number
  burstWindowMs?: number
}

// Per-event-type limits. Keys match the socket event / route they protect.
// Sustained limits are generous (never annoy a real user); burst limits are
// what actually stop floods.
export const LIMITS: Record<string, LimitRule> = {
  // auth: hello is sent once per connect; a burst of hellos is a bot
  hello: { max: 20, windowMs: 600_000, burstMax: 5, burstWindowMs: 10_000 },
  'webauthn-login-verify': { max: 20, windowMs: 600_000, burstMax: 5, burstWindowMs: 10_000 },
  // messaging: fast typers and file batches are real; floods are not
  dm: { max: 600, windowMs: 60_000, burstMax: 25, burstWindowMs: 2_000 },
  gdm: { max: 600, windowMs: 60_000, burstMax: 25, burstWindowMs: 2_000 },
  typing: { max: 600, windowMs: 60_000 },
  // calls: nobody legitimately rings more than a few times a minute
  'call-offer': { max: 30, windowMs: 60_000, burstMax: 6, burstWindowMs: 5_000 },
  'gcall-ring': { max: 15, windowMs: 60_000, burstMax: 4, burstWindowMs: 5_000 },
  // social: contact-request/invite spam is the classic abuse vector
  'contact-request': { max: 30, windowMs: 3_600_000, burstMax: 5, burstWindowMs: 30_000 },
  'create-invite': { max: 30, windowMs: 3_600_000, burstMax: 5, burstWindowMs: 30_000 },
  'group-create': { max: 20, windowMs: 3_600_000, burstMax: 4, burstWindowMs: 30_000 },
  'report-user': { max: 20, windowMs: 3_600_000, burstMax: 3, burstWindowMs: 30_000 },
  // enumeration surfaces
  search: { max: 120, windowMs: 60_000, burstMax: 15, burstWindowMs: 3_000 },
  preview: { max: 60, windowMs: 60_000, burstMax: 10, burstWindowMs: 3_000 },
  // passkey ceremonies
  'webauthn-register': { max: 10, windowMs: 3_600_000, burstMax: 3, burstWindowMs: 30_000 },
}

// Check `who` (a user id or ip) against the named rule. True = allowed.
export async function allow(rule: string, who: string): Promise<boolean> {
  const r = LIMITS[rule]
  if (!r) return true
  const n = await activeStore.incr(`rl:${rule}:${who}`, r.windowMs)
  if (n > r.max) return false
  if (r.burstMax && r.burstWindowMs) {
    const b = await activeStore.incr(`rl:${rule}:b:${who}`, r.burstWindowMs)
    if (b > r.burstMax) return false
  }
  return true
}
