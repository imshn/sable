// Live feed for the admin dashboard's Monitoring section — a separate
// Socket.IO namespace so it never shares a room with real chat traffic.
// Auth happens once at connection (handshake.auth.secret); wrong or missing
// secret just gets disconnected, no error emitted back.
import { io } from './io.js'
import { online } from './state.js'
import { perfSnapshot } from './metrics.js'

export function startAdminRealtime(): void {
  const nsp = io.of('/admin')

  nsp.use((socket, next) => {
    if (process.env.ADMIN_SECRET && socket.handshake.auth?.secret === process.env.ADMIN_SECRET) { next(); return }
    next(new Error('unauthorized'))
  })

  nsp.on('connection', (socket) => {
    const tick = () => socket.emit('snapshot', { ...perfSnapshot(), onlineCount: online.size })
    tick()
    const interval = setInterval(tick, 3000)
    socket.on('disconnect', () => clearInterval(interval))
  })
}
