// Structured logging — one pino root, one child logger per category so every
// line carries { cat: 'api' | 'socket' | 'security' | 'audit' | 'worker' | 'app' }
// and can be filtered downstream. JSON to stdout; Render captures it as-is.
//
// Never log message payloads, keys, tokens, or push subscription endpoints —
// metadata only, same rule the push payloads follow.
import { pino } from 'pino'
import { env } from './config.js'

const root = pino({
  level: env.LOG_LEVEL,
  base: undefined, // drop pid/hostname noise — single process, Render adds instance context
  timestamp: pino.stdTimeFunctions.isoTime,
})

export const log = {
  app: root.child({ cat: 'app' }),
  api: root.child({ cat: 'api' }),
  socket: root.child({ cat: 'socket' }),
  security: root.child({ cat: 'security' }),
  audit: root.child({ cat: 'audit' }),
  worker: root.child({ cat: 'worker' }),
}
