import { useState, useEffect, type RefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { Icon } from './icons.tsx'
import { avatarBg } from './avatarColor.ts'

interface Invite {
  creator_id: string
  creator_name: string
  creator_username: string
}

interface InvitePageProps {
  code: string
  socketRef: RefObject<Socket | null>
  connected: boolean
  onJoin: (creatorId: string) => void
  onCancel: () => void
}

export function InvitePage({ code, socketRef, connected, onJoin, onCancel }: InvitePageProps) {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // `socketRef` is a ref, so its identity never changes — `connected` is
    // what actually re-fires this once the socket exists and has connected;
    // without it, a page load that beats the socket's connect races forever
    // ("Loading invite..." never resolves, since a ref's .current changing
    // isn't a React dependency change).
    if (!connected || !socketRef.current) return
    socketRef.current.emit('get-invite', { code }, (response: { error?: string; invite?: Invite }) => {
      if (response.error) setError(response.error)
      else setInvite(response.invite ?? null)
    })
  }, [code, connected, socketRef])

  if (error) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <span className="invite-card-icon error">{Icon.alertCircle}</span>
          <h2>Invalid invite</h2>
          <p className="hint">{error}</p>
          <div className="invite-actions">
            <button type="button" className="primary" onClick={onCancel}>Go to App</button>
          </div>
        </div>
      </div>
    )
  }

  if (!invite) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <span className="btn-spinner invite-spinner" />
          <p className="hint" style={{ margin: 0 }}>Loading invite…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <span className="avatar profile-lg" style={{ background: avatarBg(invite.creator_id), color: '#fff' }}>
          {invite.creator_name.slice(0, 2).toUpperCase()}
        </span>
        <h2>{invite.creator_name}</h2>
        <p className="invite-username">@{invite.creator_username}</p>
        <p className="invite-text">has invited you to connect on Sable.</p>
        <div className="invite-actions">
          <button type="button" className="primary" onClick={() => onJoin(invite.creator_id)}>
            Connect<span className="btn-icon">{Icon.send}</span>
          </button>
          <button type="button" className="secondary" onClick={onCancel}>Decline</button>
        </div>
        <p className="invite-encrypted">{Icon.lock} End-to-end encrypted — the server never reads your messages</p>
      </div>
    </div>
  )
}
