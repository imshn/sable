// Operator-only analytics + operations. Everything here is metadata the
// server already stores (names, timestamps, counts, session rows) — message
// content stays ciphertext and is only ever surfaced as counts. Nothing here
// exposes conversation content, who's talking to whom right now, active
// call participants, or screen-share state.
//
// Auth: ADMIN_SECRET (same one /admin/announce already used), but failures
// return 404 so the whole /admin/* surface is indistinguishable from not
// existing, plus a per-IP lockout so the secret can't be brute-forced.
import { randomUUID } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { db } from './db.js'
import { online } from './state.js'
import { flags, config, loadFlags } from './flags.js'
import { perfSnapshot } from './metrics.js'
import { store } from './db.js'
import { vapidPublicKey } from './push.js'
import { turnServers } from './helpers.js'
import { env } from './config.js'
import { log } from './log.js'
import { enqueueAdminAudit, queueStats } from './queue.js'
import { redisHealth } from './redis.js'

const DAY = 86_400_000

// ponytail: in-memory per-IP lockout — resets on restart, fine for one relay
const failures = new Map<string, { count: number; until: number }>()
const MAX_FAILS = 5
const LOCKOUT_MS = 15 * 60_000

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '?'
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip = clientIp(req)
  const f = failures.get(ip)
  if (f && f.until > Date.now()) { res.status(404).json({ detail: 'Not Found' }); return }

  if (!env.ADMIN_SECRET || req.headers['x-admin-secret'] !== env.ADMIN_SECRET) {
    const count = (f?.count ?? 0) + 1
    failures.set(ip, { count, until: count >= MAX_FAILS ? Date.now() + LOCKOUT_MS : 0 })
    log.security.warn({ ip, count }, 'admin auth failure')
    res.status(404).json({ detail: 'Not Found' })
    return
  }
  failures.delete(ip)
  next()
}

const audit = (action: string, target: string | null, detail: string | null, ip: string) =>
  enqueueAdminAudit(randomUUID(), action, target, detail, ip)

const count = async (sql: string, args: unknown[] = []): Promise<number> => {
  if (!db) return 0
  const r = await db.execute({ sql, args: args as (string | number)[] })
  return Number(r.rows[0]?.c ?? 0)
}

// day-bucketed counts for the last 30 days: [{ day: '2026-07-10', c: 12 }]
const series = async (table: string, tsCol: string, where = ''): Promise<{ day: string; c: number }[]> => {
  if (!db) return []
  const r = await db.execute({
    sql: `SELECT strftime('%Y-%m-%d', ${tsCol}/1000, 'unixepoch') AS day, COUNT(*) AS c
          FROM ${table} WHERE ${tsCol} > ? ${where ? `AND ${where}` : ''}
          GROUP BY day ORDER BY day`,
    args: [Date.now() - 30 * DAY],
  })
  return r.rows.map((row) => ({ day: String(row.day), c: Number(row.c) }))
}

async function checkDb(): Promise<'healthy' | 'offline'> {
  if (!db) return 'offline'
  try { await db.execute('SELECT 1'); return 'healthy' } catch { return 'offline' }
}

const SORTABLE = new Set(['name', 'username', 'created_at', 'last_seen', 'sent', 'received', 'calls', 'invites', 'sessions'])

async function queryUsers(search: string, sort: string, dir: 'asc' | 'desc', limit: number, offset: number) {
  if (!db) return { rows: [], total: 0 }
  const col = SORTABLE.has(sort) ? sort : 'last_seen'
  const where = search ? `WHERE u.name LIKE ? OR u.username LIKE ?` : ''
  const args: (string | number)[] = search ? [`%${search}%`, `%${search}%`] : []
  const totalR = await db.execute({ sql: `SELECT COUNT(*) c FROM users u ${where}`, args })
  const r = await db.execute({
    sql: `
      SELECT u.id, u.name, u.username, u.created_at, u.last_seen, u.deleted, u.suspended,
             (SELECT COUNT(*) FROM messages m WHERE m.sender = u.id AND m.recipient != m.sender) AS sent,
             (SELECT COUNT(*) FROM messages m WHERE m.recipient = u.id AND m.sender != u.id) AS received,
             (SELECT COUNT(*) FROM call_logs c WHERE c.caller = u.id) AS calls,
             (SELECT COUNT(*) FROM invitations i WHERE i.creator_id = u.id) AS invites,
             (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id) AS sessions
      FROM users u ${where}
      ORDER BY ${col === 'name' || col === 'username' ? col : `u.${col}`} ${dir === 'asc' ? 'ASC' : 'DESC'}
      LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  })
  const rows = r.rows.map((row) => ({
    id: row.id, name: row.name, username: row.username,
    created_at: Number(row.created_at), last_seen: Number(row.last_seen),
    deleted: !!row.deleted, suspended: !!row.suspended,
    sent: Number(row.sent), received: Number(row.received),
    calls: Number(row.calls), invites: Number(row.invites), sessions: Number(row.sessions),
    online: online.has(String(row.id)),
  }))
  return { rows, total: Number(totalR.rows[0]?.c ?? 0) }
}

export function registerAdmin(app: Express): void {
  app.get('/admin/stats', requireAdmin, async (_req, res) => {
    const now = Date.now()

    const [
      users, newUsersToday, newUsers7d, newUsers30d, dau, wau, mau,
      groupCount, contactPairs, pushSubs, reportsTotal, reportsUnresolved,
      messagesRelayed, messages24h, messages7d, activeSessions24h, totalSessionsCount,
      invites, usedInvites,
      callsTotal, videoCalls, voiceCalls, calls24h, callsAnswered, callsMissed, callsDeclined,
      pushSent, pushDelivered, pushFailed, pushOpened, activePushDevices,
      passkeyLogins, passwordlessLogins, failedLoginsTotal, failedLogins24h,
      blockedAccounts, suspendedAccounts,
      signups, logins, messages, inviteSeries, callSeries,
    ] = await Promise.all([
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0`),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND created_at > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND created_at > ?`, [now - 7 * DAY]),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND created_at > ?`, [now - 30 * DAY]),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND last_seen > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND last_seen > ?`, [now - 7 * DAY]),
      count(`SELECT COUNT(*) c FROM users WHERE deleted=0 AND last_seen > ?`, [now - 30 * DAY]),
      count(`SELECT COUNT(*) c FROM groups`),
      count(`SELECT COUNT(*) c FROM contacts WHERE status='accepted'`),
      count(`SELECT COUNT(*) c FROM push_subscriptions`),
      count(`SELECT COUNT(*) c FROM user_reports`),
      count(`SELECT COUNT(*) c FROM user_reports WHERE resolved=0`),
      count(`SELECT COUNT(*) c FROM messages WHERE recipient != sender`),
      count(`SELECT COUNT(*) c FROM messages WHERE recipient != sender AND ts > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM messages WHERE recipient != sender AND ts > ?`, [now - 7 * DAY]),
      count(`SELECT COUNT(*) c FROM user_sessions WHERE revoked=0 AND last_active > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM user_sessions`),
      count(`SELECT COUNT(*) c FROM invitations`),
      count(`SELECT COUNT(*) c FROM invitations WHERE used_at IS NOT NULL`),
      count(`SELECT COUNT(*) c FROM call_logs`),
      count(`SELECT COUNT(*) c FROM call_logs WHERE video=1`),
      count(`SELECT COUNT(*) c FROM call_logs WHERE video=0`),
      count(`SELECT COUNT(*) c FROM call_logs WHERE ts > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM call_logs WHERE status IN ('answered','completed')`),
      count(`SELECT COUNT(*) c FROM call_logs WHERE status='missed'`),
      count(`SELECT COUNT(*) c FROM call_logs WHERE status='declined'`),
      count(`SELECT COUNT(*) c FROM push_log`),
      count(`SELECT COUNT(*) c FROM push_log WHERE ok=1`),
      count(`SELECT COUNT(*) c FROM push_log WHERE ok=0`),
      count(`SELECT COUNT(*) c FROM push_log WHERE opened_at IS NOT NULL`),
      count(`SELECT COUNT(DISTINCT user_id) c FROM push_subscriptions`),
      count(`SELECT COUNT(*) c FROM user_sessions WHERE via='passkey'`),
      count(`SELECT COUNT(*) c FROM user_sessions WHERE via='passwordless'`),
      count(`SELECT COUNT(*) c FROM failed_logins`),
      count(`SELECT COUNT(*) c FROM failed_logins WHERE ts > ?`, [now - DAY]),
      count(`SELECT COUNT(*) c FROM contacts WHERE status='blocked'`),
      count(`SELECT COUNT(*) c FROM users WHERE suspended=1`),
      series('users', 'created_at', 'deleted=0'),
      series('user_sessions', 'logged_in_at'),
      series('messages', 'ts', 'recipient != sender'),
      series('invitations', 'created_at'),
      series('call_logs', 'ts'),
    ])

    // call duration + relay mix — only over calls that actually connected
    let avgCallDurationSec = 0, longestCallDurationSec = 0, turnPct = 0
    if (db) {
      const dur = await db.execute(`
        SELECT AVG(ended_at - answered_at) a, MAX(ended_at - answered_at) m
        FROM call_logs WHERE answered_at IS NOT NULL AND ended_at IS NOT NULL`)
      avgCallDurationSec = Math.round(Number(dur.rows[0]?.a ?? 0) / 1000)
      longestCallDurationSec = Math.round(Number(dur.rows[0]?.m ?? 0) / 1000)
      const relay = await db.execute(`SELECT relay, COUNT(*) c FROM call_logs WHERE relay IS NOT NULL GROUP BY relay`)
      const relayCounts = Object.fromEntries(relay.rows.map((r) => [r.relay, Number(r.c)]))
      const relayTotal = (relayCounts.turn ?? 0) + (relayCounts.p2p ?? 0)
      turnPct = relayTotal ? +(((relayCounts.turn ?? 0) / relayTotal) * 100).toFixed(1) : 0
    }

    const [dbHealth, redisState, queues, suspiciousIps, recentLogins, reportRows, auditLog] = await Promise.all([
      checkDb(),
      redisHealth(),
      queueStats(),
      store.suspiciousIps(),
      db ? db.execute(`
        SELECT s.user_id, u.name, s.ip, s.device_hint, s.via, s.logged_in_at, s.last_active, s.revoked
        FROM user_sessions s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.logged_in_at DESC LIMIT 25`).then((r) => r.rows.map((row) => ({
          userId: row.user_id, name: row.name, ip: row.ip, device: row.device_hint, via: row.via,
          loggedInAt: Number(row.logged_in_at), lastActive: Number(row.last_active), revoked: !!row.revoked,
        }))) : [],
      db ? db.execute(`
        SELECT r.id, r.reporter_id, r.reported_id, r.category, r.details, r.created_at, r.resolved
        FROM user_reports r ORDER BY r.resolved ASC, r.created_at DESC LIMIT 50`).then((r) => r.rows.map((row) => ({
          id: row.id, reporterId: row.reporter_id, reportedId: row.reported_id,
          category: row.category, details: row.details, createdAt: Number(row.created_at), resolved: !!row.resolved,
        }))) : [],
      store.getAuditLog(50),
    ])

    const turnConfigured = !!(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) || (await turnServers()).length > 0
    const health = {
      api: 'healthy' as const,
      database: dbHealth,
      socketIo: 'healthy' as const,
      turn: turnConfigured ? 'healthy' as const : 'warning' as const,
      push: vapidPublicKey ? 'healthy' as const : 'warning' as const,
      redis: redisState,
      email: 'not_configured' as const,
      storage: 'not_configured' as const, // files are E2E-encrypted message payloads, never stored as blobs server-side
    }
    // redis down degrades to direct calls (queues fall back), so it can
    // only ever drag overall to 'warning', never 'offline'
    const core = { ...health, redis: health.redis === 'offline' ? 'warning' as const : health.redis }
    const overall = Object.values(core).some((s) => s === 'offline') ? 'offline'
      : Object.values(core).some((s) => s === 'warning') ? 'warning' : 'healthy'

    res.json({
      generatedAt: now,
      health: { ...health, overall },
      performance: perfSnapshot(),
      totals: {
        users, newUsersToday, newUsers7d, newUsers30d, dau, wau, mau,
        groups: groupCount, contactPairs, pushSubs,
        reports: reportsTotal, reportsUnresolved,
        messagesRelayed, messages24h, messages7d,
        avgMessagesPerUser: users ? +(messagesRelayed / users).toFixed(1) : 0,
        activeSessions24h, avgSessionsPerUser: users ? +(totalSessionsCount / users).toFixed(1) : 0,
        invites, usedInvites, inviteAcceptanceRatePct: invites ? +((usedInvites / invites) * 100).toFixed(1) : 0,
        callsTotal, videoCalls, voiceCalls, calls24h,
        callsAnswered, callsMissed, callsDeclined,
        avgCallDurationSec, longestCallDurationSec, turnUsagePct: turnPct,
        pushSent, pushDelivered, pushFailed,
        pushDeliveryRatePct: pushSent ? +((pushDelivered / pushSent) * 100).toFixed(1) : 0,
        pushOpened, pushOpenRatePct: pushDelivered ? +((pushOpened / pushDelivered) * 100).toFixed(1) : 0,
        activePushDevices,
        passkeyLogins, passwordlessLogins, failedLoginsTotal, failedLogins24h,
        blockedAccounts, suspendedAccounts,
      },
      online: {
        count: online.size,
        users: [...online.entries()].map(([id, u]) => ({ id, name: u.name, username: u.username })),
      },
      series: { signups, logins, messages, invites: inviteSeries, calls: callSeries },
      security: { suspiciousIps, failedLogins24h },
      queues,
      recentLogins,
      reports: reportRows,
      flags,
      config,
      auditLog,
    })
  })

  app.get('/admin/users', requireAdmin, async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'last_seen'
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc'
    const page = Math.max(0, Number(req.query.page) || 0)
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 25))
    const { rows, total } = await queryUsers(search, sort, dir, pageSize, page * pageSize)
    res.json({ rows, total, page, pageSize })
  })

  app.get('/admin/users/export.csv', requireAdmin, async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const { rows } = await queryUsers(search, 'last_seen', 'desc', 10_000, 0)
    const header = 'id,name,username,joined,last_seen,sent,received,calls,invites,sessions,online,suspended,deleted'
    const lines = rows.map((u) => [
      u.id, `"${u.name}"`, u.username, new Date(u.created_at).toISOString(), new Date(u.last_seen).toISOString(),
      u.sent, u.received, u.calls, u.invites, u.sessions, u.online, u.suspended, u.deleted,
    ].join(','))
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="sable-users-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send([header, ...lines].join('\n'))
  })

  app.post('/admin/users/:id/suspend', requireAdmin, async (req, res) => {
    const id = String(req.params.id)
    await store.setSuspended(id, true)
    await audit('suspend_user', id, null, clientIp(req))
    res.json({ ok: true })
  })

  app.post('/admin/users/:id/unsuspend', requireAdmin, async (req, res) => {
    const id = String(req.params.id)
    await store.setSuspended(id, false)
    await audit('unsuspend_user', id, null, clientIp(req))
    res.json({ ok: true })
  })

  app.post('/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
    const id = String(req.params.id)
    await store.resolveReport(id)
    await audit('resolve_report', id, null, clientIp(req))
    res.json({ ok: true })
  })

  app.post('/admin/flags/:key', requireAdmin, async (req, res) => {
    const key = String(req.params.key)
    const enabled = !!req.body?.enabled
    await store.setFeatureFlag(key, enabled)
    flags[key] = enabled
    await audit('set_feature_flag', key, String(enabled), clientIp(req))
    res.json({ ok: true })
  })

  app.post('/admin/config/:key', requireAdmin, async (req, res) => {
    const key = String(req.params.key)
    const value = String(req.body?.value ?? '')
    if (!value) { res.status(400).json({ error: 'value required' }); return }
    await store.setSystemConfig(key, value)
    config[key] = value
    await audit('set_system_config', key, value, clientIp(req))
    res.json({ ok: true })
  })

  app.post('/admin/reload-flags', requireAdmin, async (req, res) => {
    await loadFlags()
    await audit('reload_flags', null, null, clientIp(req))
    res.json({ ok: true })
  })
}
