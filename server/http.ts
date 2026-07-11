import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import { randomUUID } from 'node:crypto'
import { store } from './db.js'
import { vapidPublicKey } from './push.js'
import { turnServers, metaTags, decodeEntities } from './helpers.js'
import { broadcastAnnouncement } from './notify.js'
import { registerAdmin } from './admin.js'
import { flags, config } from './flags.js'
import { recordRequest } from './metrics.js'
import { env, originAllowed } from './config.js'
import { httpLimit, errorHandler } from './guard.js'
import { log } from './log.js'

const BOOT_ID = randomUUID().slice(0, 8)

export function createHttpApp(): Express {
  const app = express()
  // Render sits one proxy hop in front — without this req.ip is Render's
  // internal address and every rate limit hits one shared bucket.
  app.set('trust proxy', 1)
  app.use(helmet())
  app.use(compression())
  app.use(cors({ origin: (origin, cb) => cb(null, originAllowed(origin)) }))
  // Largest legit JSON body is an admin announce — nothing close to 1mb.
  app.use(express.json({ limit: '256kb' }))
  app.use((req, res, next) => {
    const start = process.hrtime.bigint()
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      // group by route pattern, not raw path, so /api/search?q=x doesn't
      // fragment into one bucket per query
      recordRequest(req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path.split('?')[0], ms, res.statusCode)
    })
    next()
  })
  registerAdmin(app)

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, boot: BOOT_ID, up: Math.round(process.uptime()) })
  })

  app.get('/turn', async (_req, res) => {
    res.json(await turnServers())
  })

  app.get('/vapid-key', (_req, res) => {
    res.json({ publicKey: vapidPublicKey })
  })

  // Public, non-sensitive runtime config — feature kill switches and the
  // handful of limits the client itself needs to enforce (session_timeout
  // and push_retry_count are server-only concerns, left out on purpose).
  app.get('/config', (_req, res) => {
    res.json({
      flags,
      maxUploadMb: Number(config.max_upload_mb) || 25,
      maxGroupParticipants: Number(config.max_group_participants) || 32,
    })
  })

  app.get('/api/search', httpLimit('search'), async (req, res) => {
    const q = req.query.q
    const uid = req.query.uid
    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100 || typeof uid !== 'string') { res.json([]); return }
    const cleanQuery = q.trim().replace(/^@/, '')
    if (cleanQuery.length < 2) { res.json([]); return }
    res.json(await store.searchUsers(cleanQuery, uid))
  })

  // Operator-triggered broadcast (no in-app admin UI — Shaan calls this
  // directly, e.g. via curl, when there's a real update to announce).
  app.post('/admin/announce', async (req, res) => {
    if (!env.ADMIN_SECRET || req.headers['x-admin-secret'] !== env.ADMIN_SECRET) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const { title, body } = req.body ?? {}
    if (!title?.trim() || !body?.trim()) {
      res.status(400).json({ error: 'title and body are required' })
      return
    }
    const notified = await broadcastAnnouncement(title.trim(), body.trim())
    res.json({ ok: true, notified })
  })

  app.get('/preview', httpLimit('preview'), async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    try {
      const rawUrl = req.query.url
      if (typeof rawUrl !== 'string') throw new Error('missing url')
      const target = new URL(rawUrl)
      if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol')
      const r = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; SablePreview/1.0)', accept: 'text/html' },
      })
      if (!(r.headers.get('content-type') ?? '').includes('text/html')) throw new Error('not html')
      const html = (await r.text()).slice(0, 400_000)
      const tags = metaTags(html)
      const title = decodeEntities(tags['og:title'] ?? tags['twitter:title'] ?? html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim())
      const description = decodeEntities(tags['og:description'] ?? tags['twitter:description'] ?? tags.description)
      let image = tags['og:image'] ?? tags['twitter:image']
      if (image) image = new URL(image, r.url ?? target).href
      res.send(JSON.stringify({ title, description, image, site: decodeEntities(tags['og:site_name']) }))
    } catch {
      res.send('{}')
    }
  })

  app.use(errorHandler)
  log.app.info({ boot: BOOT_ID }, 'http app configured')
  return app
}
