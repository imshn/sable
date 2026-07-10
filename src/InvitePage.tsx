import { useState, useEffect, type RefObject } from 'react'
import type { Socket } from 'socket.io-client'

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
        <div className="invite-card error">
          <h3>Invalid Invite</h3>
          <p>{error}</p>
          <button className="primary" onClick={onCancel}>Go to App</button>
        </div>
      </div>
    )
  }

  if (!invite) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <p>Loading invite...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <span className="avatar large">{invite.creator_name.slice(0, 2).toUpperCase()}</span>
        <h2>{invite.creator_name}</h2>
        <p>@{invite.creator_username}</p>
        <p className="invite-text">has invited you to connect on Sable.</p>
        <div className="invite-actions">
          <button className="primary" onClick={() => onJoin(invite.creator_id)}>Connect</button>
          <button className="secondary" onClick={onCancel}>Decline</button>
        </div>
      </div>
    </div>
  )
}
