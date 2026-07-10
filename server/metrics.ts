// In-process metrics only — one relay instance, no external metrics store.
// Rolling windows are plain arrays pruned on read; fine at this app's scale.
import os from 'node:os'

interface Timing { route: string; ms: number; status: number; ts: number }

const WINDOW_MS = 15 * 60_000 // keep 15 minutes of raw samples
const timings: Timing[] = []
let requestCount = 0
let errorCount = 0

const messageEvents: number[] = [] // timestamps of relayed messages
const callEvents: number[] = []    // timestamps of call offers

function prune(arr: number[], now: number): void {
  while (arr.length && arr[0] < now - WINDOW_MS) arr.shift()
}

export function recordRequest(route: string, ms: number, status: number): void {
  requestCount++
  if (status >= 500) errorCount++
  const now = Date.now()
  timings.push({ route, ms, status, ts: now })
  while (timings.length && timings[0].ts < now - WINDOW_MS) timings.shift()
}

export function recordMessage(): void { messageEvents.push(Date.now()) }
export function recordCall(): void { callEvents.push(Date.now()) }

function ratePerMinute(arr: number[], minutes: number): number {
  const now = Date.now()
  prune(arr, now)
  const since = now - minutes * 60_000
  return arr.filter((t) => t >= since).length
}

export function perfSnapshot() {
  const now = Date.now()
  const recent = timings.filter((t) => t.ts > now - 5 * 60_000)
  const byRoute = new Map<string, number[]>()
  for (const t of recent) {
    if (!byRoute.has(t.route)) byRoute.set(t.route, [])
    byRoute.get(t.route)!.push(t.ms)
  }
  const avg = (arr: number[]) => arr.reduce((s, n) => s + n, 0) / (arr.length || 1)
  const slowest = [...byRoute.entries()]
    .map(([route, ms]) => ({ route, avgMs: Math.round(avg(ms)), count: ms.length }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 8)

  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()

  return {
    avgResponseMs: Math.round(avg(recent.map((t) => t.ms))),
    slowestEndpoints: slowest,
    requestCount,
    errorCount,
    errorRatePct: requestCount ? +((errorCount / requestCount) * 100).toFixed(2) : 0,
    requestsPerMinute: recent.length ? Math.round((recent.length / 5)) : 0,
    messagesPerMinute: ratePerMinute(messageEvents, 5) / 5,
    callsPerMinute: ratePerMinute(callEvents, 5) / 5,
    cpu: { userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000), loadAvg: os.loadavg()[0] },
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), heapTotalMb: Math.round(mem.heapTotal / 1048576) },
    uptimeSec: Math.round(process.uptime()),
  }
}
