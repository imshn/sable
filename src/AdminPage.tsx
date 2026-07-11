import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { io, type Socket } from 'socket.io-client'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { Icon } from './icons.tsx'
import { avatarBg } from './avatarColor.ts'

// Operator-only dashboard, reachable only by typing /admin — nothing in the
// app links here, and the server answers 404 unless the request carries the
// right ADMIN_SECRET, so to anyone without the key this page is a dead end.
//
// What this deliberately never shows: message content, who's in a
// conversation with whom right now, live call participants, screen-share
// state. Everything below is counts, timestamps, and config — operations
// data, not surveillance.

const RELAY = import.meta.env.VITE_RELAY_URL ?? ''
const KEY_STORE = 'sable-admin-key'
const CHART_COLORS = ['#2dd4bf', '#818cf8', '#f472b6', '#fbbf24', '#60a5fa']

interface DayPoint { day: string; c: number }

interface Health {
  api: string; database: string; socketIo: string; turn: string; push: string
  redis: string; email: string; storage: string; overall: string
}

interface Performance {
  avgResponseMs: number
  slowestEndpoints: { route: string; avgMs: number; count: number }[]
  requestCount: number; errorCount: number; errorRatePct: number
  requestsPerMinute: number; messagesPerMinute: number; callsPerMinute: number
  cpu: { userMs: number; systemMs: number; loadAvg: number }
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number }
  uptimeSec: number
}

interface Totals {
  users: number; newUsersToday: number; newUsers7d: number; newUsers30d: number
  dau: number; wau: number; mau: number
  groups: number; contactPairs: number; pushSubs: number
  reports: number; reportsUnresolved: number
  messagesRelayed: number; messages24h: number; messages7d: number; avgMessagesPerUser: number
  activeSessions24h: number; avgSessionsPerUser: number
  invites: number; usedInvites: number; inviteAcceptanceRatePct: number
  callsTotal: number; videoCalls: number; voiceCalls: number; calls24h: number
  callsAnswered: number; callsMissed: number; callsDeclined: number
  avgCallDurationSec: number; longestCallDurationSec: number; turnUsagePct: number
  pushSent: number; pushDelivered: number; pushFailed: number; pushDeliveryRatePct: number
  pushOpened: number; pushOpenRatePct: number
  activePushDevices: number
  passkeyLogins: number; passwordlessLogins: number; failedLoginsTotal: number; failedLogins24h: number
  blockedAccounts: number; suspendedAccounts: number
}

interface Stats {
  generatedAt: number
  health: Health
  performance: Performance
  totals: Totals
  online: { count: number; users: { id: string; name: string; username?: string }[] }
  series: { signups: DayPoint[]; logins: DayPoint[]; messages: DayPoint[]; invites: DayPoint[]; calls: DayPoint[] }
  security: { suspiciousIps: { ip: string; count: number }[]; failedLogins24h: number }
  queues: Record<string, Record<string, number>> | null
  recentLogins: { userId: string; name?: string; ip?: string; device?: string; via: string; loggedInAt: number; lastActive: number; revoked: boolean }[]
  reports: { id: string; reporterId: string; reportedId: string; category: string; details?: string; createdAt: number; resolved: boolean }[]
  flags: Record<string, boolean>
  config: Record<string, string>
  auditLog: { id: string; action: string; target: string | null; detail: string | null; ip: string | null; ts: number }[]
}

interface UserRow {
  id: string; name: string; username: string; created_at: number; last_seen: number
  deleted: boolean; suspended: boolean; sent: number; received: number
  calls: number; invites: number; sessions: number; online: boolean
}

const fmtDateTime = (ts: number) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtDate = (ts: number) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const relative = (ts: number) => {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}
const fmtDuration = (sec: number) => {
  if (!sec) return '—'
  const m = Math.floor(sec / 60), s = sec % 60
  return m ? `${m}m ${s}s` : `${s}s`
}

function last30Days(points: DayPoint[]): DayPoint[] {
  const byDay = new Map(points.map((p) => [p.day, p.c]))
  const out: DayPoint[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const day = d.toISOString().slice(0, 10)
    out.push({ day, c: byDay.get(day) ?? 0 })
  }
  return out
}

function DayChart({ title, points, days = 30 }: { title: string; points: DayPoint[]; days?: number }) {
  const all = last30Days(points).slice(-days)
  const total = all.reduce((s, d) => s + d.c, 0)
  return (
    <div className="admin-chart">
      <div className="admin-chart-head">
        <span>{title}</span>
        <span className="admin-chart-total">{total} / {days}d</span>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <BarChart data={all} margin={{ top: 4, right: 0, left: -22, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" interval={Math.floor(days / 5)} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--muted)' }} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--muted)' }} />
          <Tooltip
            cursor={{ fill: 'var(--chip-bg-hover)' }}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10, fontSize: 12, color: 'var(--text)' }}
            labelStyle={{ color: 'var(--muted)' }} itemStyle={{ color: 'var(--accent)' }}
            formatter={(v) => [v, title]}
          />
          <Bar dataKey="c" fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function SplitChart({ title, data }: { title: string; data: { name: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="admin-chart">
      <div className="admin-chart-head"><span>{title}</span><span className="admin-chart-total">{total}</span></div>
      <ResponsiveContainer width="100%" height={130}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={30} outerRadius={55} paddingAngle={3}>
            {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10, fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="admin-card">
      <span className="admin-card-value">{value}</span>
      <span className="admin-card-label">{label}</span>
      {sub && <span className="admin-card-sub">{sub}</span>}
    </div>
  )
}

const HEALTH_LABEL: Record<string, string> = { healthy: 'Healthy', warning: 'Warning', offline: 'Offline', not_configured: 'Not Configured' }

function HealthRow({ label, status }: { label: string; status: string }) {
  return (
    <div className="admin-health-row">
      <span>{label}</span>
      <span className={`admin-badge health-${status}`}>{HEALTH_LABEL[status] ?? status}</span>
    </div>
  )
}

function SectionHead({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="admin-section-head">
      <h3><span className="admin-section-icon">{icon}</span>{title}</h3>
      {children}
    </div>
  )
}

type SectionKey = 'overview' | 'growth' | 'messaging' | 'calls' | 'notifications' | 'auth' | 'moderation' | 'users' | 'flags' | 'config' | 'audit'

const NAV: { key: SectionKey; label: string; icon: React.ReactNode }[] = [
  { key: 'overview', label: 'Overview', icon: Icon.shield },
  { key: 'growth', label: 'User Growth', icon: Icon.users },
  { key: 'messaging', label: 'Messaging', icon: Icon.send },
  { key: 'calls', label: 'Calling', icon: Icon.call },
  { key: 'notifications', label: 'Notifications', icon: Icon.bell },
  { key: 'auth', label: 'Auth & Security', icon: Icon.key },
  { key: 'moderation', label: 'Moderation', icon: Icon.flag },
  { key: 'users', label: 'Users', icon: Icon.profile },
  { key: 'flags', label: 'Feature Flags', icon: Icon.settings },
  { key: 'config', label: 'System Config', icon: Icon.settings },
  { key: 'audit', label: 'Audit Log', icon: Icon.info },
]

const SECTION_STORE = 'sable-admin-section'

export function AdminPage() {
  const [key, setKey] = useState<string | null>(() => sessionStorage.getItem(KEY_STORE))
  const [section, setSection] = useState<SectionKey>(() => (sessionStorage.getItem(SECTION_STORE) as SectionKey) || 'overview')
  const [input, setInput] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState<{ requestsPerMinute: number; messagesPerMinute: number; callsPerMinute: number; onlineCount: number; memory: Performance['memory']; cpu: Performance['cpu'] } | null>(null)
  const socketRef = useRef<Socket | null>(null)

  // Users tab: server-side search/sort/pagination, independent of the stats poll
  const [userSearch, setUserSearch] = useState('')
  const [userSort, setUserSort] = useState('last_seen')
  const [userDir, setUserDir] = useState<'asc' | 'desc'>('desc')
  const [userPage, setUserPage] = useState(0)
  const [userData, setUserData] = useState<{ rows: UserRow[]; total: number } | null>(null)
  const pageSize = 25

  const authHeaders = useCallback((k: string) => ({ 'x-admin-secret': k }), [])

  const load = useCallback(async (k: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${RELAY}/admin/stats`, { headers: authHeaders(k) })
      if (!res.ok) throw new Error('bad key')
      setStats(await res.json())
      sessionStorage.setItem(KEY_STORE, k)
      setKey(k)
    } catch {
      sessionStorage.removeItem(KEY_STORE)
      setKey(null)
      setStats(null)
      setError('That key was not accepted.')
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  const loadUsers = useCallback(async (k: string) => {
    const params = new URLSearchParams({ search: userSearch, sort: userSort, dir: userDir, page: String(userPage), pageSize: String(pageSize) })
    const res = await fetch(`${RELAY}/admin/users?${params}`, { headers: authHeaders(k) })
    if (res.ok) setUserData(await res.json())
  }, [userSearch, userSort, userDir, userPage, authHeaders])

  useEffect(() => {
    if (!key) return
    load(key)
    const t = setInterval(() => load(key), 60_000)
    return () => clearInterval(t)
  }, [key, load])

  useEffect(() => {
    if (!key) return
    loadUsers(key)
  }, [key, loadUsers])

  // Live monitoring feed — separate authenticated namespace, never shares a
  // room with real chat traffic.
  useEffect(() => {
    if (!key) return
    const socket = io(`${RELAY}/admin`, { auth: { secret: key }, transports: ['websocket'] })
    socketRef.current = socket
    socket.on('snapshot', (snap) => setLive(snap))
    return () => { socket.disconnect() }
  }, [key])

  const act = useCallback(async (path: string, body?: unknown) => {
    if (!key) return false
    const res = await fetch(`${RELAY}${path}`, {
      method: 'POST', headers: { ...authHeaders(key), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.ok
  }, [key, authHeaders])

  const toggleFlag = async (flagKey: string, enabled: boolean) => {
    if (!stats) return
    setStats({ ...stats, flags: { ...stats.flags, [flagKey]: enabled } })
    await act(`/admin/flags/${flagKey}`, { enabled })
  }

  const [configDraft, setConfigDraft] = useState<Record<string, string>>({})
  useEffect(() => { if (stats) setConfigDraft(stats.config) }, [stats])
  const saveConfig = async (configKey: string) => {
    await act(`/admin/config/${configKey}`, { value: configDraft[configKey] })
    if (key) load(key)
  }

  const suspendUser = async (id: string, suspended: boolean) => {
    await act(`/admin/users/${id}/${suspended ? 'unsuspend' : 'suspend'}`)
    if (key) { loadUsers(key); load(key) }
  }

  const resolveReport = async (id: string) => {
    await act(`/admin/reports/${id}/resolve`)
    if (key) load(key)
  }

  const exportCsv = () => {
    if (!key) return
    const params = new URLSearchParams({ search: userSearch })
    fetch(`${RELAY}/admin/users/export.csv?${params}`, { headers: authHeaders(key) })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `sable-users-${new Date().toISOString().slice(0, 10)}.csv`
        a.click()
        URL.revokeObjectURL(url)
      })
  }

  const goToSection = (s: SectionKey) => { setSection(s); sessionStorage.setItem(SECTION_STORE, s) }

  const sortHeader = (col: string, label: string) => (
    <th className="admin-sortable" onClick={() => { setUserSort(col); setUserDir(userSort === col && userDir === 'desc' ? 'asc' : 'desc'); setUserPage(0) }}>
      {label}{userSort === col ? (userDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  )

  const callSplit = useMemo(() => stats ? [
    { name: 'Video', value: stats.totals.videoCalls },
    { name: 'Voice', value: stats.totals.voiceCalls },
  ] : [], [stats])

  const outcomeSplit = useMemo(() => stats ? [
    { name: 'Answered', value: stats.totals.callsAnswered },
    { name: 'Missed', value: stats.totals.callsMissed },
    { name: 'Declined', value: stats.totals.callsDeclined },
  ] : [], [stats])

  const authSplit = useMemo(() => stats ? [
    { name: 'Passkey', value: stats.totals.passkeyLogins },
    { name: 'Passwordless', value: stats.totals.passwordlessLogins },
  ] : [], [stats])

  if (!key || !stats) {
    return (
      <div className="invite-page" style={{ height: '100dvh' }}>
        <div className="invite-card" style={{ maxWidth: 380 }}>
          <span className="invite-card-icon">{Icon.shield}</span>
          <h2>Operator access</h2>
          <p className="hint">This area is restricted.</p>
          {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}
          <form
            style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}
            onSubmit={(e: FormEvent) => { e.preventDefault(); if (input.trim()) load(input.trim()) }}
          >
            <input type="password" placeholder="Admin key" value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
            <button type="submit" className="primary" disabled={loading || !input.trim()}>
              {loading && <span className="btn-spinner" />}Unlock
            </button>
          </form>
        </div>
      </div>
    )
  }

  const t = stats.totals
  const flagLabels: Record<string, string> = {
    voice_calls: 'Voice Calls', video_calls: 'Video Calls', screen_share: 'Screen Share',
    push_notifications: 'Push Notifications', groups: 'Groups', registration: 'New Registration',
  }
  const configLabels: Record<string, string> = {
    max_upload_mb: 'Max upload size (MB)', max_group_participants: 'Max group participants',
    invite_expiry_hours: 'Invite expiry (hours)', session_timeout_hours: 'Session timeout (hours)',
    push_retry_count: 'Push retry count',
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="wordmark compact"><img src="/logo-mark.png" alt="" className="wordmark-logo" /> sable · admin</div>
        <div className="admin-header-actions">
          <span className={`admin-badge health-${stats.health.overall}`}>{HEALTH_LABEL[stats.health.overall]}</span>
          <span className="admin-updated">updated {relative(stats.generatedAt)}</span>
          <button type="button" className="icon-btn subtle" title="Refresh" onClick={() => load(key)} disabled={loading}>{Icon.rotate}</button>
          <button type="button" className="icon-btn subtle" title="Lock" onClick={() => { sessionStorage.removeItem(KEY_STORE); setKey(null); setStats(null) }}>{Icon.signout}</button>
        </div>
      </header>

      <div className="admin-shell">
        <nav className="admin-sidebar">
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`admin-nav-item ${section === n.key ? 'active' : ''}`}
              onClick={() => goToSection(n.key)}
            >
              {n.icon}{n.label}
            </button>
          ))}
        </nav>

        <div className="admin-main">
      {section === 'overview' && <>
      {/* 1. Platform Health */}
      <section className="admin-section">
        <SectionHead icon={Icon.shield} title="Platform Health" />
        <div className="admin-health-grid">
          <HealthRow label="API" status={stats.health.api} />
          <HealthRow label="Database" status={stats.health.database} />
          <HealthRow label="Socket.IO" status={stats.health.socketIo} />
          <HealthRow label="Redis" status={stats.health.redis} />
          <HealthRow label="Cloudflare TURN" status={stats.health.turn} />
          <HealthRow label="Push Notifications" status={stats.health.push} />
          <HealthRow label="Email" status={stats.health.email} />
          <HealthRow label="Storage" status={stats.health.storage} />
        </div>
      </section>

      {/* 2. Performance Metrics */}
      <section className="admin-section">
        <SectionHead icon={Icon.rotate} title="Performance" />
        <div className="admin-cards">
          <StatCard label="Avg response time" value={`${stats.performance.avgResponseMs} ms`} />
          <StatCard label="Requests (5m avg/min)" value={live?.requestsPerMinute ?? stats.performance.requestsPerMinute} />
          <StatCard label="Error rate" value={`${stats.performance.errorRatePct}%`} sub={`${stats.performance.errorCount} / ${stats.performance.requestCount}`} />
          <StatCard label="Active connections" value={live?.onlineCount ?? stats.online.count} />
          <StatCard label="Memory (RSS)" value={`${live?.memory.rssMb ?? stats.performance.memory.rssMb} MB`} sub={`heap ${live?.memory.heapUsedMb ?? stats.performance.memory.heapUsedMb}/${live?.memory.heapTotalMb ?? stats.performance.memory.heapTotalMb} MB`} />
          <StatCard label="Load average" value={(live?.cpu.loadAvg ?? stats.performance.cpu.loadAvg).toFixed(2)} />
          <StatCard label="Uptime" value={fmtDuration(stats.performance.uptimeSec)} />
          <StatCard label="Messages/min (live)" value={(live?.messagesPerMinute ?? stats.performance.messagesPerMinute).toFixed(1)} />
          <StatCard label="Calls/min (live)" value={(live?.callsPerMinute ?? stats.performance.callsPerMinute).toFixed(1)} />
        </div>
        {stats.queues ? (
          <div className="admin-cards" style={{ marginTop: 12 }}>
            {Object.entries(stats.queues).map(([name, c]) => (
              <StatCard
                key={name}
                label={`Queue: ${name}`}
                value={`${(c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0)} pending`}
                sub={`${c.failed ?? 0} failed (DLQ) · ${c.completed ?? 0} done`}
              />
            ))}
          </div>
        ) : (
          <p className="hint">Background queues run once REDIS_URL is configured — until then push and audit writes go direct.</p>
        )}
        {stats.performance.slowestEndpoints.length > 0 && (
          <div className="admin-table-wrap" style={{ marginTop: 12 }}>
            <table className="admin-table">
              <thead><tr><th>Endpoint</th><th>Avg ms</th><th>Requests (5m)</th></tr></thead>
              <tbody>
                {stats.performance.slowestEndpoints.map((e) => (
                  <tr key={e.route}><td>{e.route}</td><td>{e.avgMs}</td><td>{e.count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Online now */}
      <section className="admin-section">
        <SectionHead icon={Icon.globe} title={`Online now (${stats.online.count})`} />
        {stats.online.count === 0 ? (
          <p className="hint">No one is connected right now.</p>
        ) : (
          <div className="admin-online">
            {stats.online.users.map((u) => (
              <span key={u.id} className="admin-chip">
                <span className="avatar small-avatar" style={{ background: avatarBg(u.id), color: '#fff' }}>{u.name.slice(0, 2).toUpperCase()}</span>
                {u.name}{u.username ? ` · @${u.username}` : ''}
              </span>
            ))}
          </div>
        )}
      </section>
      </>}

      {section === 'growth' && <>
      {/* 3. User Growth */}
      <section className="admin-section">
        <SectionHead icon={Icon.users} title="User Growth" />
        <div className="admin-cards">
          <StatCard label="Total Users" value={t.users} />
          <StatCard label="New Today" value={t.newUsersToday} />
          <StatCard label="New This Week" value={t.newUsers7d} />
          <StatCard label="New This Month" value={t.newUsers30d} />
          <StatCard label="DAU" value={t.dau} />
          <StatCard label="WAU" value={t.wau} />
          <StatCard label="MAU" value={t.mau} />
          <StatCard label="DAU/MAU (stickiness)" value={t.mau ? `${((t.dau / t.mau) * 100).toFixed(0)}%` : '—'} />
          <StatCard label="Invite Acceptance Rate" value={`${t.inviteAcceptanceRatePct}%`} sub={`${t.usedInvites}/${t.invites} used`} />
        </div>
        <div className="admin-charts my-2">
          <DayChart title="Daily signups" points={stats.series.signups} />
          <DayChart title="Logins" points={stats.series.logins} />
        </div>
      </section>
      </>}

      {section === 'messaging' && <>
      {/* 4. Messaging Analytics */}
      <section className="admin-section">
        <SectionHead icon={Icon.send} title="Messaging Analytics" />
        <div className="admin-cards">
          <StatCard label="Messages Today" value={t.messages24h} />
          <StatCard label="Messages This Week" value={t.messages7d} />
          <StatCard label="Messages All-Time" value={t.messagesRelayed} />
          <StatCard label="Avg per User" value={t.avgMessagesPerUser} />
        </div>
        <div className="admin-charts my-2">
          <DayChart title="Messages relayed" points={stats.series.messages} />
        </div>
      </section>
      </>}

      {section === 'calls' && <>
      {/* 5. Calling Analytics */}
      <section className="admin-section">
        <SectionHead icon={Icon.call} title="Calling Analytics" />
        <div className="admin-cards">
          <StatCard label="Total Voice Calls" value={t.voiceCalls} />
          <StatCard label="Total Video Calls" value={t.videoCalls} />
          <StatCard label="Calls Today" value={t.calls24h} />
          <StatCard label="Answered" value={t.callsAnswered} />
          <StatCard label="Missed" value={t.callsMissed} />
          <StatCard label="Declined" value={t.callsDeclined} />
          <StatCard label="Avg Duration" value={fmtDuration(t.avgCallDurationSec)} />
          <StatCard label="Longest Call" value={fmtDuration(t.longestCallDurationSec)} />
        </div>
        <div className="admin-charts my-2">
          <DayChart title="Calls per day" points={stats.series.calls} />
          <SplitChart title="Voice vs Video" data={callSplit} />
          <SplitChart title="Outcome" data={outcomeSplit} />
        </div>
      </section>

      {/* 6. Cloudflare TURN Analytics */}
      <section className="admin-section">
        <SectionHead icon={Icon.globe} title="Cloudflare TURN Analytics" />
        <p className="hint my-2">
          Bandwidth and per-session relay metrics need Cloudflare's own API (not configured here) — what's below is
          derived from this app's own call telemetry.
        </p>
        <div className="admin-cards">
          <StatCard label="TURN Config" value={HEALTH_LABEL[stats.health.turn]} />
          <StatCard label="Relay (TURN) Usage" value={`${t.turnUsagePct}%`} sub="of calls with a detected candidate type" />
          <StatCard label="Direct P2P Usage" value={`${(100 - t.turnUsagePct).toFixed(1)}%`} />
        </div>
      </section>
      </>}

      {section === 'notifications' && <>
      {/* 7. Notification Analytics */}
      <section className="admin-section">
        <SectionHead icon={Icon.bell} title="Notification Analytics" />
        <div className="admin-cards">
          <StatCard label="Push Sent" value={t.pushSent} />
          <StatCard label="Delivered" value={t.pushDelivered} />
          <StatCard label="Failed" value={t.pushFailed} />
          <StatCard label="Delivery Rate" value={`${t.pushDeliveryRatePct}%`} />
          <StatCard label="Opened" value={t.pushOpened} sub="clicked the notification" />
          <StatCard label="Open Rate" value={`${t.pushOpenRatePct}%`} />
          <StatCard label="Active Push Devices" value={t.activePushDevices} />
        </div>
      </section>
      </>}

      {section === 'auth' && <>
      {/* 8. Authentication Analytics */}
      <section className="admin-section">
        <SectionHead icon={Icon.key} title="Authentication Analytics" />
        <div className="admin-cards">
          <StatCard label="Passkey Logins" value={t.passkeyLogins} />
          <StatCard label="Passwordless Logins" value={t.passwordlessLogins} />
          <StatCard label="Failed Logins (24h)" value={t.failedLogins24h} sub={`${t.failedLoginsTotal} all-time`} />
          <StatCard label="Active Sessions (24h)" value={t.activeSessions24h} />
          <StatCard label="Avg Sessions / User" value={t.avgSessionsPerUser} />
        </div>
        <div className="admin-charts my-4">
          <SplitChart title="Login method" data={authSplit} />
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>User</th><th>Device</th><th>Via</th><th>IP</th><th>Logged in</th><th>Last active</th><th>Session</th></tr></thead>
            <tbody>
              {stats.recentLogins.map((l, i) => (
                <tr key={i}>
                  <td>{l.name ?? l.userId}</td><td>{l.device ?? '—'}</td><td>{l.via}</td><td>{l.ip ?? '—'}</td>
                  <td>{fmtDateTime(l.loggedInAt)}</td><td>{relative(l.lastActive)}</td>
                  <td>{l.revoked ? <span className="admin-badge muted">ended</span> : <span className="admin-badge on">active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 14. Security Dashboard (grouped near auth) */}
      <section className="admin-section">
        <SectionHead icon={Icon.alertCircle} title="Security" />
        <div className="admin-cards">
          <StatCard label="Failed Logins (24h)" value={stats.security.failedLogins24h} />
          <StatCard label="Suspicious IPs" value={stats.security.suspiciousIps.length} sub="3+ failed attempts/hour" />
        </div>
        {stats.security.suspiciousIps.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>IP</th><th>Failed attempts (1h)</th></tr></thead>
              <tbody>
                {stats.security.suspiciousIps.map((s) => (
                  <tr key={s.ip}><td>{s.ip}</td><td>{s.count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">IPs with 10+ failed attempts in 10 minutes are already rejected outright at login — this list is everything short of that threshold.</p>
      </section>
      </>}

      {section === 'moderation' && <>
      {/* 9. Moderation */}
      <section className="admin-section my-2">
        <SectionHead icon={Icon.flag} title="Moderation" />
        <div className="admin-cards">
          <StatCard label="Reports" value={t.reports} sub={`${t.reportsUnresolved} unresolved`} />
          <StatCard label="Blocked Contacts" value={t.blockedAccounts} />
          <StatCard label="Suspended Accounts" value={t.suspendedAccounts} />
        </div>
        {stats.reports.length === 0 ? (
          <p className="hint">No user reports.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Reported</th><th>By</th><th>Category</th><th>Details</th><th>When</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {stats.reports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.reportedId}</td><td>{r.reporterId}</td><td>{r.category}</td>
                    <td className="admin-details">{r.details || '—'}</td><td>{fmtDateTime(r.createdAt)}</td>
                    <td>{r.resolved ? <span className="admin-badge muted">resolved</span> : <span className="admin-badge">open</span>}</td>
                    <td>
                      {!r.resolved && <button type="button" className="secondary" style={{ minHeight: 30, padding: '0 12px' }} onClick={() => resolveReport(r.id)}>Resolve</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </>}

      {section === 'users' && <>
      {/* 10. User Management */}
      <section className="admin-section">
        <SectionHead icon={Icon.profile} title={`Users (${userData?.total ?? '…'})`}>
          <div className="admin-user-controls">
            <input type="text" placeholder="Search name or username…" value={userSearch} onChange={(e) => { setUserSearch(e.target.value); setUserPage(0) }} />
            <button type="button" className="secondary" onClick={exportCsv}>{Icon.download} Export CSV</button>
          </div>
        </SectionHead>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                {sortHeader('name', 'User')}
                {sortHeader('username', 'Username')}
                {sortHeader('created_at', 'Joined')}
                {sortHeader('last_seen', 'Last seen')}
                {sortHeader('sent', 'Sent')}
                {sortHeader('received', 'Received')}
                {sortHeader('calls', 'Calls')}
                {sortHeader('invites', 'Invites')}
                {sortHeader('sessions', 'Logins')}
                <th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(userData?.rows ?? []).map((u) => (
                <tr key={u.id} className={u.deleted ? 'deleted' : ''}>
                  <td>{u.name}</td><td>@{u.username}</td><td>{fmtDate(u.created_at)}</td><td>{relative(u.last_seen)}</td>
                  <td>{u.sent}</td><td>{u.received}</td><td>{u.calls}</td><td>{u.invites}</td><td>{u.sessions}</td>
                  <td>
                    {u.deleted ? <span className="admin-badge muted">deleted</span>
                      : u.suspended ? <span className="admin-badge health-warning">suspended</span>
                      : u.online ? <span className="admin-badge on">online</span> : <span className="admin-badge">offline</span>}
                  </td>
                  <td>
                    {!u.deleted && (
                      <button type="button" className="secondary" style={{ minHeight: 30, padding: '0 12px' }} onClick={() => suspendUser(u.id, u.suspended)}>
                        {u.suspended ? 'Unsuspend' : 'Suspend'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {userData && userData.total > pageSize && (
          <div className="admin-pagination">
            <button type="button" className="secondary" disabled={userPage === 0} onClick={() => setUserPage((p) => p - 1)}>Previous</button>
            <span>Page {userPage + 1} of {Math.ceil(userData.total / pageSize)}</span>
            <button type="button" className="secondary" disabled={(userPage + 1) * pageSize >= userData.total} onClick={() => setUserPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </section>
      </>}

      {section === 'flags' && <>
      {/* 12. Feature Flags */}
      <section className="admin-section">
        <SectionHead icon={Icon.settings} title="Feature Flags" />
        <div className="admin-flag-grid">
          {Object.entries(stats.flags).map(([k, enabled]) => (
            <div key={k} className="admin-flag-row">
              <span>{flagLabels[k] ?? k}</span>
              <button type="button" className={`toggle-switch ${enabled ? 'on' : ''}`} aria-pressed={enabled} onClick={() => toggleFlag(k, !enabled)}>
                <span className="toggle-thumb" />
              </button>
            </div>
          ))}
        </div>
      </section>
      </>}

      {section === 'config' && <>
      {/* 13. System Configuration */}
      <section className="admin-section">
        <SectionHead icon={Icon.settings} title="System Configuration" />
        <div className="admin-config-grid">
          {Object.entries(configLabels).map(([k, label]) => (
            <div key={k} className="admin-config-row">
              <label>{label}</label>
              <div className="admin-config-input">
                <input type="number" value={configDraft[k] ?? ''} onChange={(e) => setConfigDraft({ ...configDraft, [k]: e.target.value })} />
                <button type="button" className="secondary" onClick={() => saveConfig(k)}>Save</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      </>}

      {section === 'audit' && <>
      {/* 11. Audit Log */}
      <section className="admin-section">
        <SectionHead icon={Icon.info} title="Audit Log" />
        {stats.auditLog.length === 0 ? (
          <p className="hint">No admin actions recorded yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Action</th><th>Target</th><th>Detail</th><th>IP</th><th>When</th></tr></thead>
              <tbody>
                {stats.auditLog.map((a) => (
                  <tr key={a.id}>
                    <td>{a.action}</td><td>{a.target ?? '—'}</td><td>{a.detail ?? '—'}</td><td>{a.ip ?? '—'}</td><td>{fmtDateTime(a.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </>}
        </div>
      </div>
    </div>
  )
}
