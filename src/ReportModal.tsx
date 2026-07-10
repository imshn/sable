import { useState } from 'react'
import type { Socket } from 'socket.io-client'
import { Icon } from './icons.tsx'

const CATEGORIES = [
  { value: 'spam',                 label: 'Spam',                  desc: 'Sending unwanted or repetitive messages' },
  { value: 'harassment',           label: 'Harassment',            desc: 'Threatening, bullying, or abusive behavior' },
  { value: 'fake_account',         label: 'Fake Account',          desc: 'Impersonating another person or entity' },
  { value: 'inappropriate_content',label: 'Inappropriate Content', desc: 'Sharing explicit or offensive material' },
  { value: 'scam',                 label: 'Scam or Fraud',         desc: 'Attempting to deceive or defraud others' },
  { value: 'other',                label: 'Other',                 desc: 'Something else not listed above' },
] as const

interface ReportModalProps {
  targetName: string
  targetId: string
  socket: Socket | null | undefined
  onClose: () => void
}

export function ReportModal({ targetName, targetId, socket, onClose }: ReportModalProps) {
  const [category, setCategory] = useState<string | null>(null)
  const [details, setDetails] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const submit = () => {
    if (!category || !socket) return
    setSubmitting(true)
    socket.emit('report-user', { reportedId: targetId, category, details: details.trim() })
    socket.once('report-sent', () => {
      setSubmitting(false)
      setDone(true)
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Report user" onClick={e => e.stopPropagation()}
        style={{ maxWidth: 480, width: '95vw' }}>
        <header className="modal-head">
          <h3>Report {targetName}</h3>
          <button className="icon-btn subtle" aria-label="Close" onClick={onClose}>{Icon.x}</button>
        </header>

        {done ? (
          <div style={{ padding: '32px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
            <span style={{ color: 'var(--accent)', display: 'flex' }}><span style={{ transform: 'scale(1.6)' }}>{Icon.checkCircle}</span></span>
            <h4 style={{ margin: 0 }}>Report submitted</h4>
            <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.9rem' }}>Thank you for helping keep Sable safe. Our moderation team will review your report.</p>
            <button className="primary" style={{ width: 'auto', padding: '10px 24px', marginTop: 8 }} onClick={onClose}>Done</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '8px 0 0' }}>
            <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.9rem' }}>
              Select a reason for reporting this user. Reports are anonymous and reviewed by our team.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {CATEGORIES.map(cat => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setCategory(cat.value)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px',
                    borderRadius: 'var(--radius)', border: '2px solid',
                    borderColor: category === cat.value ? 'var(--accent)' : 'var(--border)',
                    backgroundColor: category === cat.value ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--surface-2)',
                    color: 'var(--text)', textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  <span style={{ marginTop: 2, color: category === cat.value ? 'var(--accent)' : 'var(--muted)', flexShrink: 0 }}>
                    {category === cat.value ? Icon.checkCircle : Icon.flag}
                  </span>
                  <div>
                    <div style={{ fontWeight: '500', fontSize: '0.95rem' }}>{cat.label}</div>
                    <div style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: 2 }}>{cat.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {category && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Additional details <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
                <textarea
                  value={details}
                  onChange={e => setDetails(e.target.value)}
                  placeholder="Provide any additional context that might help our team…"
                  maxLength={500}
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
                <span style={{ fontSize: '0.78rem', color: 'var(--muted)', alignSelf: 'flex-end' }}>{details.length}/500</span>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="primary"
                style={{ backgroundColor: category ? 'var(--danger)' : undefined }}
                disabled={!category || submitting}
                onClick={submit}
              >
                {submitting ? 'Submitting…' : 'Submit Report'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
