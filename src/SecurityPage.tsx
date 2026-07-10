import { useState, useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { Icon } from './icons.tsx'
import { usePending } from './usePending.ts'
import type { SessionRow, LoginHistoryRow, Passkey, PasskeyActionResult } from './types.ts'

const RELATIVE = (ts: number | null | undefined) => {
  if (!ts) return 'Unknown'
  const diff = Date.now() - Number(ts)
  if (diff < 60_000) return 'Just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return new Date(Number(ts)).toLocaleDateString()
}

const deviceLabel = (t: string) => (t === 'singleDevice' ? 'This device only' : t === 'multiDevice' ? 'Synced (phone/cloud)' : 'Unknown type')

interface SecurityPageProps {
  socket: Socket | null | undefined
  passkeys: Passkey[] | null
  onFetchPasskeys?: () => void
  onDeletePasskey?: (credentialId: string, onDone?: (ok: boolean) => void) => void
  onRegisterPasskey?: () => Promise<PasskeyActionResult>
}

export function SecurityPage({ socket, passkeys, onFetchPasskeys, onDeletePasskey, onRegisterPasskey }: SecurityPageProps) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [history, setHistory] = useState<LoginHistoryRow[] | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokingAll, setRevokingAll] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [addingPasskey, setAddingPasskey] = useState(false)
  const [passkeyMsg, setPasskeyMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const { isPending, run } = usePending()

  useEffect(() => {
    if (!socket) return
    const handle = (s: SessionRow[]) => setSessions(s)
    socket.on('sessions', handle)
    socket.emit('get-sessions', (s: SessionRow[]) => setSessions(s))
    return () => { socket.off('sessions', handle) }
  }, [socket])

  useEffect(() => {
    if (!socket) return
    socket.emit('get-login-history', (rows: LoginHistoryRow[]) => setHistory(rows))
  }, [socket])

  useEffect(() => {
    onFetchPasskeys?.()
  }, [onFetchPasskeys])

  const addPasskey = async () => {
    setAddingPasskey(true)
    setPasskeyMsg(null)
    const res = await onRegisterPasskey?.()
    setAddingPasskey(false)
    if (res?.ok) setPasskeyMsg({ text: 'Passkey added — future logins for this username will require it.' })
    else if (res?.error !== 'Cancelled') setPasskeyMsg({ text: res?.error ?? 'Could not add passkey', error: true })
  }

  const revoke = (sessionId: string) => {
    setRevoking(sessionId)
    socket?.emit('revoke-session', { sessionId }, () => setRevoking(null))
  }

  const revokeAll = () => {
    setRevokingAll(true)
    socket?.emit('revoke-all-sessions', () => {
      setRevokingAll(false)
      setConfirmed(false)
    })
  }

  const current = sessions?.find(s => s.isCurrent)
  const others = sessions?.filter(s => !s.isCurrent) || []

  if (!sessions) return <div className="settings-loading">Loading session data…</div>

  return (
    <div style={{ maxWidth: 540, display: 'flex', flexDirection: 'column', gap: 32 }}>

      {/* Passkeys */}
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.key}</span>
          Passkeys
        </div>
        <p className="empty-sub" style={{ marginTop: 0, marginBottom: 12 }}>
          {passkeys?.length
            ? 'Your username is locked to these passkeys — logging in anywhere else requires one of them.'
            : "Anyone who types your username can currently sign in as you. Add a passkey to require your device's biometrics or PIN instead."}
        </p>

        {passkeys === null ? (
          <p className="empty-sub">Loading…</p>
        ) : passkeys.length === 0 ? null : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
            {passkeys.map((pk) => (
              <div key={pk.id} className="session-card">
                <div className="session-card-icon">{Icon.key}</div>
                <div className="session-card-body">
                  <span className="session-device">{deviceLabel(pk.deviceType)}</span>
                  <span className="session-meta">Added {RELATIVE(pk.createdAt)}</span>
                  {pk.lastUsed && <span className="session-meta">Last used {RELATIVE(pk.lastUsed)}</span>}
                </div>
                <button
                  type="button"
                  className="secondary danger-btn"
                  style={{ flexShrink: 0, padding: '6px 14px', fontSize: '0.8rem' }}
                  disabled={isPending(`passkey:${pk.credentialId}`)}
                  onClick={() => run(`passkey:${pk.credentialId}`, (done) => onDeletePasskey?.(pk.credentialId, done))}
                >
                  {isPending(`passkey:${pk.credentialId}`) && <span className="btn-spinner" />}Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {passkeyMsg && (
          <p className="hint" style={{ color: passkeyMsg.error ? 'var(--danger)' : 'var(--accent)', marginBottom: 12 }}>
            {passkeyMsg.text}
          </p>
        )}

        <button
          type="button"
          className="secondary"
          style={{ width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px' }}
          disabled={addingPasskey}
          onClick={addPasskey}
        >
          {addingPasskey ? <span className="btn-spinner" /> : Icon.key} {addingPasskey ? 'Follow your browser\'s prompt…' : 'Add a passkey'}
        </button>
      </div>

      {/* Current session */}
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.device}</span>
          Current Session
        </div>
        {current ? (
          <div className="session-card current">
            <div className="session-card-icon">{Icon.device}</div>
            <div className="session-card-body">
              <span className="session-device">{current.device_hint || 'Unknown device'}</span>
              <span className="session-meta">Active now · {current.ip || 'IP hidden'}</span>
              <span className="session-meta">Logged in {RELATIVE(current.logged_in_at)}</span>
            </div>
            <span className="session-badge">This device</span>
          </div>
        ) : (
          <p className="empty-sub">No session data available.</p>
        )}
      </div>

      {/* Other sessions */}
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.shield}</span>
          Active Sessions
          {others.length > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--muted)' }}>{others.length} other{others.length > 1 ? 's' : ''}</span>
          )}
        </div>

        {others.length === 0 ? (
          <p className="empty-sub">No other active sessions.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {others.map(s => (
              <div key={s.id} className="session-card">
                <div className="session-card-icon">{Icon.device}</div>
                <div className="session-card-body">
                  <span className="session-device">{s.device_hint || 'Unknown device'}</span>
                  <span className="session-meta">Last active {RELATIVE(s.last_active)} · {s.ip || 'IP hidden'}</span>
                  <span className="session-meta">Logged in {RELATIVE(s.logged_in_at)}</span>
                </div>
                <button
                  type="button"
                  className="secondary danger-btn"
                  disabled={revoking === s.id}
                  onClick={() => revoke(s.id)}
                  style={{ flexShrink: 0, padding: '6px 14px', fontSize: '0.8rem' }}
                >
                  {revoking === s.id && <span className="btn-spinner" />}{revoking === s.id ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            ))}

            {!confirmed ? (
              <button type="button" className="secondary" style={{ width: 'auto', alignSelf: 'flex-start', marginTop: 8, padding: '10px 20px' }} onClick={() => setConfirmed(true)}>
                Sign out from all other devices
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                <span style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>Are you sure?</span>
                <button type="button" className="primary danger-btn" style={{ width: 'auto', padding: '8px 18px' }} disabled={revokingAll} onClick={revokeAll}>
                  {revokingAll && <span className="btn-spinner" />}Confirm
                </button>
                <button type="button" className="secondary" style={{ width: 'auto', padding: '8px 14px' }} disabled={revokingAll} onClick={() => setConfirmed(false)}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Login history */}
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.info}</span>
          Login History
        </div>
        <p className="empty-sub" style={{ marginTop: 0, marginBottom: 12 }}>Your last 20 logins on any device.</p>

        {history === null ? (
          <p className="empty-sub">Loading…</p>
        ) : history.length === 0 ? (
          <p className="empty-sub">No login history yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {history.map((h) => (
              <div key={h.id} className="session-card">
                <div className="session-card-icon">{Icon.device}</div>
                <div className="session-card-body">
                  <span className="session-device">{h.device_hint || 'Unknown device'}</span>
                  <span className="session-meta">{RELATIVE(h.logged_in_at)} · {h.ip || 'IP hidden'}</span>
                </div>
                <span className="session-badge" style={!h.revoked ? undefined : { opacity: 0.6 }}>
                  {h.revoked ? 'Signed out' : 'Active'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
