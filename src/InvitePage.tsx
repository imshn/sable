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
  onJoin: (creatorId: string) => void
  onCancel: () => void
}

export function InvitePage({ code, socketRef, onJoin, onCancel }: InvitePageProps) {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!socketRef.current) return
    socketRef.current.emit('get-invite', { code }, (response: { error?: string; invite?: Invite }) => {
      if (response.error) setError(response.error)
      else setInvite(response.invite ?? null)
    })
  }, [code, socketRef])

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
