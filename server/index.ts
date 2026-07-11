// Sable relay server — routes ciphertext, public keys, and WebRTC signaling.
// With Turso configured it also persists ciphertext history and offline
// deliveries; the server still cannot read any message content.
//
// Bootstrap only: build the Express app + Socket.IO server, restore
// in-memory state from the DB, and wire each domain module's handlers onto
// every new connection. The actual route/event logic lives in http.ts and
// sockets/*.ts.
import { createServer } from 'node:http'
import { env } from './config.js'
import { log } from './log.js'
import { migrate, store } from './db.js'
import { createHttpApp } from './http.js'
import { initIo } from './io.js'
import { known, groups } from './state.js'
import { loadFlags } from './flags.js'
import { startAdminRealtime } from './realtime.js'
import { packetGuard, wrapSocketErrors } from './guard.js'
import { redisEnabled, makeRedis } from './redis.js'
import { startWorkers, scheduleMaintenance } from './queue.js'
import { registerPresence } from './sockets/presence.js'
import { registerContacts } from './sockets/contacts.js'
import { registerGroups } from './sockets/groups.js'
import { registerMessages } from './sockets/messages.js'
import { registerCalls } from './sockets/calls.js'
import { registerSettings } from './sockets/settings.js'
import type { AppSocket } from './types.js'

process.on('uncaughtException', (e) => log.app.fatal({ err: e instanceof Error ? e.stack : String(e) }, 'uncaughtException'))
process.on('unhandledRejection', (e) => log.app.error({ err: e instanceof Error ? e.stack : String(e) }, 'unhandledRejection'))

const httpServer = createServer(createHttpApp())
const io = initIo(httpServer)

// Multi-instance readiness, deliberately gated: on a single instance the
// Redis adapter adds a distant-region round trip to every broadcast for
// zero benefit. Flip REDIS_SCALE_OUT=1 when a second instance exists.
if (redisEnabled && env.REDIS_SCALE_OUT === '1') {
  const { createAdapter } = await import('@socket.io/redis-adapter')
  io.adapter(createAdapter(makeRedis(), makeRedis()))
  const { setCounterStore, RedisCounterStore } = await import('./rateLimit.js')
  setCounterStore(new RedisCounterStore(makeRedis()))
  log.app.info('scale-out mode: socket.io redis adapter + shared rate-limit counters')
}

await migrate()
await loadFlags()
for (const u of await store.allUsers()) {
  known.set(u.id, { name: u.name, username: u.username, pubKey: JSON.parse(u.pubkey), lastSeen: Number(u.last_seen) })
}
for (const g of await store.loadGroups()) {
  groups.set(g.id, { name: g.name, owner: g.owner, members: new Set(g.members) })
}
log.app.info({ users: known.size, groups: groups.size }, 'state restored')

io.on('connection', (socket: AppSocket) => {
  const ip = (socket.handshake.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
             || socket.handshake.address
  // Boundary first: error containment wraps every handler the modules
  // register below; packetGuard rate-limits and shape-checks every packet
  // before any handler runs.
  wrapSocketErrors(socket)
  packetGuard(socket, ip)
  const ctx = registerPresence(socket)
  registerContacts(socket, ctx)
  registerGroups(socket, ctx)
  registerMessages(socket, ctx)
  registerCalls(socket, ctx)
  registerSettings(socket, ctx)
})

startAdminRealtime()

// In-process queue workers (no-ops without REDIS_URL). Jobs live in Redis,
// so a restart never loses queued work — server/worker.ts is the standalone
// entrypoint for the day these move to a dedicated background service.
startWorkers()
await scheduleMaintenance()

httpServer.listen(env.PORT, '0.0.0.0', () => log.app.info({ port: env.PORT }, 'sable relay listening'))
