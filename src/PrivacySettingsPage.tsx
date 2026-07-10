import { useState, useEffect, useRef, type ReactNode } from 'react'
import type { Socket } from 'socket.io-client'
import { Icon } from './icons.tsx'
import type { PrivacySettings } from './types.ts'

type PrivacyLevel = 'everyone' | 'contacts' | 'nobody'
type PrivacyKey = keyof PrivacySettings

const PRIVACY_OPTIONS: { value: PrivacyLevel; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'nobody',   label: 'Nobody' },
]

interface PrivacyRowProps {
  label: string
  description?: ReactNode
  value: PrivacyLevel
  onChange: (value: PrivacyLevel) => void
}

function PrivacyRow({ label, description, value, onChange }: PrivacyRowProps) {
  return (
    <div className="privacy-row">
      <div className="privacy-row-label">
        <span className="privacy-row-title">{label}</span>
        {description && <span className="privacy-row-desc">{description}</span>}
      </div>
      <div className="privacy-row-options">
        {PRIVACY_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`privacy-opt-btn ${value === opt.value ? 'active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {value === opt.value && <span className="privacy-opt-check">{Icon.check}</span>}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function PrivacySettingsPage({ socket }: { socket: Socket | null | undefined }) {
  const [settings, setSettings] = useState<PrivacySettings | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!socket) return
    const handleSettings = (s: PrivacySettings) => setSettings(s)
    socket.on('privacy-settings', handleSettings)
    socket.emit('get-privacy-settings')
    return () => { socket.off('privacy-settings', handleSettings) }
  }, [socket])

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const update = (key: PrivacyKey, val: PrivacyLevel) => {
    if (!settings) return
    const next = { ...settings, [key]: val }
    setSettings(next)
    socket?.emit('save-privacy-settings', next)
    setToast('Privacy setting updated')
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2000)
  }

  if (!settings) {
    return <div className="settings-loading">Loading privacy settings…</div>
  }

  return (
    <div className="privacy-settings-page" style={{ maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.bell}</span>
          Messaging & Calls
        </div>
        <div className="privacy-rows">
          <PrivacyRow
            label="Who can message me"
            description="Controls who can send you direct messages"
            value={settings.message_privacy}
            onChange={v => update('message_privacy', v)}
          />
          <PrivacyRow
            label="Who can call me"
            description="Controls who can initiate voice or video calls"
            value={settings.call_privacy}
            onChange={v => update('call_privacy', v)}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">
          <span className="settings-section-icon">{Icon.eye}</span>
          Visibility
        </div>
        <div className="privacy-rows">
          <PrivacyRow
            label="Last Seen"
            description="Who can see when you were last active"
            value={settings.last_seen_privacy}
            onChange={v => update('last_seen_privacy', v)}
          />
          <PrivacyRow
            label="Online Status"
            description="Who can see when you're currently online"
            value={settings.online_privacy}
            onChange={v => update('online_privacy', v)}
          />
          <PrivacyRow
            label="Profile Picture"
            description="Who can see your profile photo"
            value={settings.avatar_privacy}
            onChange={v => update('avatar_privacy', v)}
          />
          <PrivacyRow
            label="Bio / About"
            description="Who can see your bio text"
            value={settings.bio_privacy}
            onChange={v => update('bio_privacy', v)}
          />
        </div>
      </div>

      {toast && (
        <div
          style={{
            position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px',
            backgroundColor: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            fontSize: '0.9rem', color: 'var(--accent)', zIndex: 20,
          }}
        >
          {Icon.checkCircle} {toast}
        </div>
      )}
    </div>
  )
}
