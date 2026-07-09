import React, { useState, useEffect } from 'react'
import { Icon } from './icons.jsx'

const PRIVACY_OPTIONS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'nobody',   label: 'Nobody' },
]

function PrivacyRow({ label, description, value, onChange }) {
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

export function PrivacySettingsPage({ socket }) {
  const [settings, setSettings] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!socket) return
    const handleSettings = (s) => setSettings(s)
    socket.on('privacy-settings', handleSettings)
    socket.emit('get-privacy-settings')
    return () => socket.off('privacy-settings', handleSettings)
  }, [socket])

  const update = (key, val) => {
    setSettings(prev => ({ ...prev, [key]: val }))
    setSaved(false)
  }

  const save = () => {
    if (!socket || !settings) return
    setSaving(true)
    socket.emit('save-privacy-settings', settings)
    // Optimistically mark saved
    setTimeout(() => { setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000) }, 300)
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="primary" onClick={save} disabled={saving} style={{ width: 'auto', padding: '10px 24px' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        {saved && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontSize: '0.9rem' }}>
            {Icon.checkCircle} Saved
          </span>
        )}
      </div>
    </div>
  )
}
