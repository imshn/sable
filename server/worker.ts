// Standalone worker entrypoint — run `tsx server/worker.ts` as a separate
// process/service to take queue processing out of the API server entirely.
// Not used by default (index.ts runs the same workers in-process); this
// exists so splitting them later is a start-command change, not a code
// change. Jobs persist in Redis, so both processes running workers at once
// is also safe — BullMQ distributes jobs between them.
import { env } from './config.js'
import { log } from './log.js'
import { loadFlags } from './flags.js'
import { redisEnabled } from './redis.js'
import { startWorkers, scheduleMaintenance } from './queue.js'

if (!redisEnabled) {
  log.worker.fatal('REDIS_URL is required to run the standalone worker')
  process.exit(1)
}

await loadFlags() // push delivery reads push_notifications flag + retry config
startWorkers()
await scheduleMaintenance()
log.worker.info({ port: env.PORT }, 'standalone worker running')
