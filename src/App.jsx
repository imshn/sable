import { useEffect, useRef, useState } from 'react'
import { useChat } from './useChat.js'
import { useCall } from './useCall.js'
import { Icon } from './icons.jsx'
import { Thread, callLogText, Linkified } from './Thread.jsx'
import { ContactsPage } from './ContactsPage.jsx'
import { ProfileSettingsModal } from './ProfileSettingsModal.jsx'
import { ConfirmModal } from './ConfirmModal.jsx'
import { InvitePage } from './InvitePage.jsx'

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('sable-theme') ?? 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('sable-theme', theme)
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}

function ThemeToggle({ className }) {
  const [theme, toggle] = useTheme()
  return (
    <button
      className={`icon-btn subtle ${className ?? ''}`}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
      onClick={toggle}
    >
      {theme === 'dark' ? Icon.sun : Icon.moon}
    </button>
  )
}

function Welcome({ onEnter }) {
  const [name, setName] = useState(localStorage.getItem('sable-name') ?? '')
  const [username, setUsername] = useState(localStorage.getItem('sable-username') ?? '')

  const submit = (e) => {
    e.preventDefault()
    const trimmedName = name.trim()
    const trimmedUsername = username.trim().toLowerCase()
    if (!trimmedName || !trimmedUsername) return
    localStorage.setItem('sable-name', trimmedName)
    localStorage.setItem('sable-username', trimmedUsername)
    onEnter({ name: trimmedName, username: trimmedUsername })
  }

  return (
    <div className="lobby">
      <section className="lobby-brand">
        <div className="wordmark">
          <span className="wordmark-glyph">{Icon.lock}</span>
          sable
          <ThemeToggle className="lobby-theme" />
        </div>
        <h1>
          Conversations that
          <br />
          belong to <em>no one else.</em>
        </h1>
        <ul className="assurances">
          <li>
            <strong>End-to-end encrypted</strong>
            <span>ECDH key agreement, AES-256-GCM per message and file</span>
          </li>
          <li>
            <strong>Keys never leave this device</strong>
            <span>Generated in your browser, non-extractable</span>
          </li>
          <li>
            <strong>The server reads nothing</strong>
            <span>History is stored as ciphertext only; calls go peer-to-peer</span>
          </li>
        </ul>
      </section>

      <section className="lobby-panel">
        <form onSubmit={submit}>
          <h2>Who are you?</h2>
          <label htmlFor="username">Username (Unique)</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_.]/g, ''))}
            placeholder="e.g. johndoe"
            maxLength={32}
            autoComplete="off"
            autoFocus
          />
          
          <label htmlFor="name" style={{ marginTop: '1rem' }}>Display Name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="How others will see you"
            maxLength={32}
            autoComplete="off"
          />
          <p className="hint">Anyone can find you by your username to send a contact request.</p>
          <button type="submit" className="primary" disabled={!name.trim() || !username.trim()}>
            Enter Sable
            <span className="btn-icon">{Icon.send}</span>
          </button>
        </form>
      </section>
    </div>
  )
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const initials = (n) => n.trim().slice(0, 2).toUpperCase()

const previewText = (last, targetName) => {
  const body = last?.body
  if (!body) return ''
  if (last.deleted) return 'Message deleted'
  if (last.kind === 'call') return callLogText(body, targetName)
  if (last.kind === 'sys') return body.text
  if (body.t === 'loc') return 'Location'
  if (body.t === 'file') {
    if (body.caption) return body.caption
    if (body.voice) return 'Voice message'
    if (body.mime?.startsWith('image/')) return 'Photo'
    if (body.mime?.startsWith('video/')) return 'Video'
    if (body.mime?.startsWith('audio/')) return 'Audio'
    return body.name
  }
  return body.text
}

function Sidebar({ name, rows, convos, activeId, onSelect, onNewGroup, onShowProfile, safetyCode, connected, onSignOut }) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <div className="wordmark compact">
          <span className="wordmark-glyph">{Icon.lock}</span>
          sable
        </div>
        <div className="me">
          <span className={`status-dot ${connected ? 'on' : ''}`} aria-hidden="true" />
          {name}
          <ThemeToggle />
          <button className="icon-btn subtle" aria-label="Profile Settings" title="Profile Settings" onClick={onShowProfile}>
            {Icon.settings}
          </button>
          <button className="icon-btn subtle" aria-label="New Group" title="New Group" onClick={onNewGroup}>
            {Icon.plus}
          </button>
          <button className="icon-btn subtle" aria-label="Contacts" title="Contacts" onClick={() => onSelect('contacts')}>
            {Icon.users}
          </button>
          <button className="icon-btn subtle" aria-label="Sign out" onClick={onSignOut}>
            {Icon.signout}
          </button>
        </div>
      </header>

      <div className="contact-list" role="list">
        {rows.length === 0 && (
          <div className="side-empty">
            <p>No one else is online.</p>
            <p className="empty-sub">Contacts appear here the moment they enter Sable.</p>
          </div>
        )}
        {rows.map((r) => {
          const convo = convos[r.id]
          const last = convo?.messages[convo.messages.length - 1]
          return (
            <button
              key={r.id}
              role="listitem"
              className={`contact ${r.id === activeId ? 'active' : ''}`}
              onClick={() => onSelect(r.id)}
            >
              <span className={`avatar ${r.isGroup ? 'group' : ''}`} aria-hidden="true">
                {r.isGroup ? Icon.users : initials(r.name)}
              </span>
              <span className="contact-body">
                <span className="contact-top">
                  <span className="contact-name">{r.name}</span>
                  {last && <time className="contact-time">{timeFmt.format(last.ts)}</time>}
                </span>
                <span className="contact-bottom">
                  <span className="contact-preview">
                    {convo?.typing ? (
                      <em className="typing-note">{r.isGroup ? `${convo.typing} is typing…` : 'typing…'}</em>
                    ) : last ? (
                      `${last.kind === 'self' ? 'You: ' : ''}${previewText(last, r.name)}`
                    ) : r.isGroup ? (
                      `${r.memberCount} members`
                    ) : r.online ? (
                      'online'
                    ) : (
                      'offline'
                    )}
                  </span>
                  {convo?.unread > 0 && <span className="unread">{convo.unread}</span>}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <footer className="sidebar-footer" title="Compare this code with your peer over another channel to verify encryption">
        <span className="safety-icon">{Icon.lock}</span>
        <span className="safety-label">safety code</span>
        <code>{safetyCode || '· · · ·'}</code>
      </footer>
    </aside>
  )
}

function NewGroupModal({ contacts, onCreate, onClose }) {
  const [groupName, setGroupName] = useState('')
  const [picked, setPicked] = useState(new Set())

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="New group" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>New group</h3>
          <button className="icon-btn subtle" aria-label="Close" onClick={onClose}>{Icon.x}</button>
        </header>
        <input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="Group name"
          maxLength={48}
          aria-label="Group name"
          autoFocus
        />
        {contacts.length === 0 ? (
          <p className="hint">No one else is online to add.</p>
        ) : (
          <div className="fwd-list">
            {contacts.map((c) => (
              <button
                key={c.id}
                className={`contact pickable ${picked.has(c.id) ? 'picked' : ''}`}
                onClick={() => toggle(c.id)}
                aria-pressed={picked.has(c.id)}
              >
                <span className="avatar" aria-hidden="true">{initials(c.name)}</span>
                <span className="contact-name">{c.name}</span>
                <span className="pick-mark">{picked.has(c.id) ? Icon.check : Icon.plus}</span>
              </button>
            ))}
          </div>
        )}
        <button
          className="primary"
          disabled={!groupName.trim() || picked.size === 0}
          onClick={() => { onCreate(groupName.trim(), [...picked]); onClose() }}
        >
          Create group
          <span className="btn-icon">{Icon.users}</span>
        </button>
      </div>
    </div>
  )
}

// Autoplay-safe video: browsers block unmuted autoplay once the user-gesture
// window (~5s) lapses, which is how long ICE can take — the classic "call
// connected but screen stays black". Fall back to muted playback + unmute pill.
// When the video track goes dark (camera off), show the person instead of a void.
function Video({ stream, muted, className, allowUnmute, label, personName, forceAvatar, isMicOff }) {
  const ref = useRef(null)
  const [blocked, setBlocked] = useState(false)
  const [videoDark, setVideoDark] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream ?? null
    if (!stream) return
    setBlocked(false)
    el.muted = !!muted
    el.play().catch(() => {
      el.muted = true
      el.play().catch(() => {})
      if (!muted) setBlocked(true)
    })
  }, [stream, muted])

  // remote camera-off: the sender disabling their track stops RTP, which
  // surfaces here as the track's mute event
  useEffect(() => {
    const track = stream?.getVideoTracks()[0]
    if (!track) {
      setVideoDark(true)
      return
    }
    const update = () => setVideoDark(track.muted)
    update()
    track.addEventListener('mute', update)
    track.addEventListener('unmute', update)
    return () => {
      track.removeEventListener('mute', update)
      track.removeEventListener('unmute', update)
    }
  }, [stream])

  const showAvatar = forceAvatar || videoDark
  return (
    <div className={`video-wrap ${className ?? ''}`}>
      <video ref={ref} autoPlay playsInline muted={muted} />
      {showAvatar && personName && (
        <div className="video-avatar">
          <span className="avatar big-tile">{initials(personName)}</span>
          <span className="video-avatar-name">{personName}</span>
        </div>
      )}
      {isMicOff && (
        <div className="video-mic-muted" title="Microphone off">
          {Icon.micOff}
        </div>
      )}
      {label && !showAvatar && <span className="video-label">{label}</span>}
      {blocked && allowUnmute && (
        <button
          className="unmute-pill"
          onClick={() => {
            if (ref.current) {
              ref.current.muted = false
              ref.current.play().catch(() => {})
            }
            setBlocked(false)
          }}
        >
          {Icon.volume} Tap to unmute
        </button>
      )}
    </div>
  )
}

// text-only chat panel inside a call, Meet style — same encrypted conversation
function CallChat({ convo, names, onSend, onClose }) {
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)
  const messages = convo?.messages.filter((m) => m.kind === 'self' || m.kind === 'peer') ?? []

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length])

  const submit = (e) => {
    e.preventDefault()
    if (!draft.trim()) return
    onSend(draft.trim())
    setDraft('')
  }

  return (
    <aside className="call-chat">
      <header className="call-chat-head">
        <span>In-call messages</span>
        <button className="icon-btn subtle" aria-label="Close chat" onClick={onClose}>{Icon.x}</button>
      </header>
      <div className="call-chat-list" ref={listRef}>
        {messages.length === 0 && <p className="hint">Messages stay in the conversation after the call.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`call-chat-msg ${m.kind === 'self' ? 'self' : ''}`}>
            <span className="call-chat-sender">{m.kind === 'self' ? 'you' : m.name ?? names(m.from)}</span>
            <span className="call-chat-text">
              {m.deleted ? 'Message deleted' : m.body.t === 'text' ? <Linkified text={m.body.text} /> : previewText(m, '')}
            </span>
          </div>
        ))}
      </div>
      <form className="call-chat-composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Send a message…"
          aria-label="In-call message"
          autoComplete="off"
        />
        <button type="submit" className="primary send small-send" disabled={!draft.trim()} aria-label="Send">
          {Icon.send}
        </button>
      </form>
    </aside>
  )
}

function QualityPill({ quality }) {
  if (!quality) return null
  const label = { excellent: 'Excellent', good: 'Good', poor: 'Poor' }[quality.level]
  return (
    <span
      className={`quality q-${quality.level}`}
      title={`RTT ${quality.rttMs ?? '–'} ms · packet loss ${quality.lossPct}% · ${quality.kbps} kbps incoming`}
    >
      <span className="q-bars" aria-hidden="true"><i /><i /><i /></span>
      {label}
    </span>
  )
}

function CallOverlay({
  call, title, names, localStream, remoteStreams, micOn, camOn, sharing, sharers, camsOff, micsOff, quality, lowBandwidth,
  onToggleMic, onToggleCam, onToggleShare, onHangup, inviteCandidates, onInvite,
  convo, onSendChat, onReadChat,
}) {
  const remotes = Object.entries(remoteStreams)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [rung, setRung] = useState(new Set())
  const [chatOpen, setChatOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const canShare = !!navigator.mediaDevices?.getDisplayMedia

  // Meet-style presenting layout: the shared screen takes the stage (shown
  // whole), everyone else minimizes into a filmstrip
  const remoteSharer = Object.keys(sharers).find((id) => remoteStreams[id])
  const presenting = sharing || !!remoteSharer
  const stageStream = sharing ? localStream : remoteSharer ? remoteStreams[remoteSharer] : null
  const stripRemotes = remotes.filter(([id]) => !(remoteSharer && id === remoteSharer))

  const unread = convo?.unread ?? 0
  useEffect(() => {
    if (chatOpen && unread) onReadChat()
  }, [chatOpen, unread, onReadChat])

  // toast the newest incoming message when the panel is closed
  const lastMsg = convo?.messages[convo.messages.length - 1]
  useEffect(() => {
    if (!lastMsg || lastMsg.kind !== 'peer' || chatOpen) return
    setToast({ id: lastMsg.id, name: lastMsg.name ?? names(lastMsg.from), text: previewText(lastMsg, '') })
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [lastMsg?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="call-overlay" role="dialog" aria-label={`Call with ${title}`}>
      <div className={`call-stage ${chatOpen ? 'with-chat' : ''}`}>
        <div className="call-main" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="call-topbar">
            <span className="safety-icon">{Icon.lock}</span>
            {title}
            <span className="call-note">{sharing ? 'sharing your screen' : 'peer-to-peer, encrypted'}</span>
            <QualityPill quality={quality} />
          </div>

          <div className="call-content" style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
            {presenting && stageStream ? (
              <>
                <Video
                  stream={stageStream}
                  muted={sharing}
                  className="stage-video"
                  allowUnmute={!sharing}
                  label={sharing ? 'You are presenting' : `${names(remoteSharer)} is presenting`}
                  personName={sharing ? 'You' : names(remoteSharer)}
                />
                <div className="filmstrip">
                  {stripRemotes.map(([peerId, stream]) => (
                    <Video key={peerId} stream={stream} className="strip-tile" label={names(peerId)} personName={names(peerId)} forceAvatar={!!camsOff[peerId]} isMicOff={!!micsOff[peerId]} />
                  ))}
                  {!sharing && <Video stream={localStream} muted className="strip-tile" label="you" personName="You" forceAvatar={!camOn} />}
                </div>
              </>
            ) : remotes.length === 0 ? (
              <div className="call-waiting">
                <span className="avatar big">{call.mode === 'group' ? Icon.users : initials(title)}</span>
                <p>{call.status === 'outgoing' ? `Calling ${title}…` : call.mode === 'group' ? 'Waiting for others to join…' : 'Connecting…'}</p>
              </div>
            ) : (
              <div className={`remote-grid n${Math.min(remotes.length, 4)}`}>
                {remotes.map(([peerId, stream]) => (
                  <Video key={peerId} stream={stream} className="remote-video" allowUnmute label={names(peerId)} personName={names(peerId)} forceAvatar={!!camsOff[peerId]} isMicOff={!!micsOff[peerId]} />
                ))}
              </div>
            )}
            {!presenting && <Video stream={localStream} muted className="local-video" personName="You" forceAvatar={!camOn} />}
            
            {lowBandwidth && (
              <div className="chat-toast bw-toast">
                Poor connection — video paused, audio continues. Tap the camera to turn it back on.
              </div>
            )}
            {toast && !chatOpen && (
              <button className="chat-toast" style={{ bottom: '16px' }} onClick={() => { setChatOpen(true); setToast(null) }}>
                <strong>{toast.name}</strong> {toast.text}
              </button>
            )}
          </div>

          <div className="call-controls">
            <button className={`call-btn ${micOn ? '' : 'off'}`} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'} onClick={onToggleMic}>
              {micOn ? Icon.mic : Icon.micOff}
            </button>
            <button className={`call-btn ${camOn ? '' : 'off'}`} aria-label={camOn ? 'Turn camera off' : 'Turn camera on'} onClick={onToggleCam}>
              {camOn ? Icon.video : Icon.videoOff}
            </button>
            {canShare && (
              <button
                className={`call-btn ${sharing ? 'sharing' : ''}`}
                aria-label={sharing ? 'Stop sharing screen' : 'Share screen'}
                title={sharing ? 'Stop sharing' : 'Share a tab, window, or your screen'}
                onClick={onToggleShare}
              >
                {sharing ? Icon.monitorOff : Icon.monitor}
              </button>
            )}
            <button
              className={`call-btn ${chatOpen ? 'sharing' : ''} chat-toggle`}
              aria-label={chatOpen ? 'Close in-call chat' : 'Open in-call chat'}
              onClick={() => setChatOpen(!chatOpen)}
            >
              {Icon.copy}
              {unread > 0 && !chatOpen && <span className="unread chat-unread">{unread}</span>}
            </button>
            {call.mode === 'group' && inviteCandidates.length > 0 && (
              <div className="composer-anchor">
                <button
                  className="call-btn"
                  aria-label="Invite to call"
                  aria-expanded={inviteOpen}
                  title="Invite group members to this call"
                  onClick={() => setInviteOpen(!inviteOpen)}
                >
                  {Icon.userPlus}
                </button>
                {inviteOpen && (
                  <div className="drawer invite-drawer" role="menu" style={{ bottom: 'calc(100% + 14px)' }}>
                    {inviteCandidates.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="drawer-item"
                        role="menuitem"
                        disabled={rung.has(m.id)}
                        onClick={() => {
                          onInvite(m.id)
                          setRung(new Set([...rung, m.id]))
                        }}
                      >
                        <span className="avatar small-avatar">{initials(m.name)}</span>
                        {rung.has(m.id) ? `Ringing ${m.name}…` : m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button className="call-btn end" aria-label="End call" onClick={onHangup}>
              {Icon.phoneEnd}
            </button>
          </div>
        </div>
        {chatOpen && <CallChat convo={convo} names={names} onSend={onSendChat} onClose={() => setChatOpen(false)} />}
      </div>
    </div>
  )
}

// generic online-contact picker (add members to a group)
function MemberPicker({ title, contacts, onPick, onClose }) {
  const [picked, setPicked] = useState(new Set())

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn subtle" aria-label="Close" onClick={onClose}>{Icon.x}</button>
        </header>
        {contacts.length === 0 ? (
          <p className="hint">Everyone online is already in this group.</p>
        ) : (
          <div className="fwd-list">
            {contacts.map((c) => (
              <button
                key={c.id}
                className={`contact pickable ${picked.has(c.id) ? 'picked' : ''}`}
                onClick={() => toggle(c.id)}
                aria-pressed={picked.has(c.id)}
              >
                <span className="avatar" aria-hidden="true">{initials(c.name)}</span>
                <span className="contact-name">{c.name}</span>
                <span className="pick-mark">{picked.has(c.id) ? Icon.check : Icon.plus}</span>
              </button>
            ))}
          </div>
        )}
        <button
          className="primary"
          disabled={picked.size === 0}
          onClick={() => { onPick([...picked]); onClose() }}
        >
          Add to group
          <span className="btn-icon">{Icon.userPlus}</span>
        </button>
      </div>
    </div>
  )
}

function IncomingCall({ title, subtitle, isGroup, onAccept, onDecline }) {
  return (
    <div className="incoming" role="alertdialog" aria-label={`Incoming call: ${title}`}>
      <span className={`avatar ${isGroup ? 'group' : ''}`} aria-hidden="true">
        {isGroup ? Icon.users : initials(title)}
      </span>
      <div className="incoming-body">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <button className="call-btn end small" aria-label="Decline call" onClick={onDecline}>
        {Icon.phoneEnd}
      </button>
      <button className="call-btn accept small" aria-label="Accept call" onClick={onAccept}>
        {Icon.video}
      </button>
    </div>
  )
}

function ForwardPicker({ rows, excludeId, onPick, onClose }) {
  const list = rows.filter((r) => r.id !== excludeId)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Forward to" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Forward to…</h3>
          <button className="icon-btn subtle" aria-label="Close" onClick={onClose}>{Icon.x}</button>
        </header>
        {list.length === 0 && <p className="hint">No other chats to forward to.</p>}
        <div className="fwd-list">
          {list.map((r) => (
            <button key={r.id} className="contact" onClick={() => { onPick(r.id); onClose() }}>
              <span className={`avatar ${r.isGroup ? 'group' : ''}`} aria-hidden="true">
                {r.isGroup ? Icon.users : initials(r.name)}
              </span>
              <span className="contact-name">{r.name}</span>
              <span className="fwd-go">{Icon.forward}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Shell({ name, username, onSignOut }) {
  const [activeId, setActiveId] = useState('contacts')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [addingTo, setAddingTo] = useState(null)
  const [forwarding, setForwarding] = useState(null)
  const [inviteCode, setInviteCode] = useState(() => {
    const path = window.location.pathname
    if (path.startsWith('/invite/')) return path.split('/')[2]
    return null
  })
  const chat = useChat(name, username)
  const {
    clientId, contacts, groups, convos, connected, safetyCode, sessionReplaced, authError, myProfile,
    send, react, deleteForAll, deleteForMe, addLocalEntry,
    createGroup, deleteGroup, leaveGroup, inviteToGroup,
    sendContactRequest, acceptContactRequest, rejectContactRequest, removeContact, blockContact, unblockContact,
    notifyTyping, markRead, socketRef
  } = chat

  useEffect(() => {
    // We now render a ConfirmModal for authError below instead of alert
  }, [authError])
  const {
    call, localStream, remoteStreams, micOn, camOn, sharing, sharers, camsOff, micsOff, quality, lowBandwidth,
    startCall, startGroupCall, accept, decline, hangup, toggleMic, toggleCam, toggleShare, inviteToCall,
  } = useCall(socketRef, clientId, (target, log) => addLocalEntry(target, { t: 'call', ...log }))

  const [inviting, setInviting] = useState(false)

  // merged sidebar rows: groups + contacts, most recent first
  const sidebarRows = [
    ...groups.map((g) => ({ ...g, isGroup: true, memberCount: g.members.length })),
    ...contacts.filter(c => c.status === 'accepted'),
  ].sort((a, b) => {
    const tsA = Math.max(convos[a.id]?.lastTs || 0, a.lastSeen || 0)
    const tsB = Math.max(convos[b.id]?.lastTs || 0, b.lastSeen || 0)
    return tsB - tsA
  })

  // resolve the open thread target (direct contact or group)
  const activeContact = contacts.find((c) => c.id === activeId)
  const activeGroup = groups.find((g) => g.id === activeId)
  const activePeerName = activeGroup ? activeGroup.name : activeContact?.name

  const forward = async (targetId, msg) => {
    const body = msg.body
    if (body.t === 'file') {
      const buf = await (await fetch(body.url)).arrayBuffer()
      const { b64encode } = await import('./crypto.js')
      send(targetId, { ...body, url: undefined, data: b64encode(buf), fwd: true })
    } else {
      send(targetId, { ...body, fwd: true })
    }
    setActiveId(targetId)
  }

  if (sessionReplaced) {
    return (
      <div className="lobby">
        <section className="lobby-panel" style={{ margin: 'auto' }}>
          <form onSubmit={(e) => { e.preventDefault(); location.reload() }}>
            <h2>Signed in elsewhere</h2>
            <p className="hint">
              "{name}" just connected from another tab or device, so this session was closed.
              Only one active session per name is allowed.
            </p>
            <button type="submit" className="primary">
              Use Sable here instead
              <span className="btn-icon">{Icon.send}</span>
            </button>
          </form>
        </section>
      </div>
    )
  }

  return (
    <div className={`shell ${activeId ? 'thread-open' : ''}`}>
      <Sidebar
        name={name}
        rows={sidebarRows}
        convos={convos}
        activeId={activeId}
        onSelect={setActiveId}
        onNewGroup={() => setCreatingGroup(true)}
        safetyCode={safetyCode}
        connected={connected}
        onSignOut={onSignOut}
        onShowProfile={() => setShowProfile(true)}
      />
      <main className="call-stage with-chat">
        {inviteCode ? (
          <InvitePage 
            code={inviteCode} 
            socketRef={socketRef} 
            onJoin={(userId) => {
              sendContactRequest(userId)
              setInviteCode(null)
              window.history.pushState({}, '', '/')
            }}
            onCancel={() => {
              setInviteCode(null)
              window.history.pushState({}, '', '/')
            }}
          />
        ) : call.status !== 'idle' ? (
          <CallOverlay
            call={call}
            title={call.groupId ? groups.find(g => g.id === call.groupId)?.name : contacts.find(c => c.id === call.peerId)?.name}
            names={(id) => contacts.find((c) => c.id === id)?.name ?? groups.flatMap((g) => g.members).find((m) => m.id === id)?.name ?? 'Unknown'}
            localStream={localStream}
            remoteStreams={remoteStreams}
            micOn={micOn}
            camOn={camOn}
            sharing={sharing}
            sharers={sharers}
            camsOff={camsOff}
            micsOff={micsOff}
            quality={quality}
            lowBandwidth={lowBandwidth}
            onToggleMic={toggleMic}
            onToggleCam={toggleCam}
            onToggleShare={toggleShare}
            onHangup={hangup}
            convo={convos[call.groupId ?? call.peerId]}
            onSendChat={(text) => send(call.groupId ?? call.peerId, { t: 'text', text })}
            onReadChat={() => markRead(call.groupId ?? call.peerId)}
            inviteCandidates={
              call.groupId
                ? (groups.find((g) => g.id === call.groupId)?.members ?? []).filter(
                    (m) => m.id !== clientId && !remoteStreams[m.id] && contacts.some((c) => c.id === m.id && c.online)
                  )
                : []
            }
            onInvite={inviteToCall}
          />
        ) : activeId === 'contacts' ? (
          <ContactsPage 
            clientId={clientId}
            contacts={contacts} 
            onChat={(id) => setActiveId(id)}
            onVoiceCall={(id) => startCall(id, false)}
            onVideoCall={(id) => startCall(id, true)}
            sendContactRequest={sendContactRequest}
            acceptContactRequest={acceptContactRequest}
            rejectContactRequest={rejectContactRequest}
            removeContact={removeContact}
            blockContact={blockContact}
            unblockContact={unblockContact}
            socketRef={socketRef}
          />
        ) : activeId ? (
          <Thread
            key={activeId}
            target={activeGroup ? { ...activeGroup, isGroup: true } : { ...activeContact, isGroup: false }}
            convo={convos[activeId]}
            clientId={clientId}
            onBack={() => setActiveId(null)}
            onSend={(env) => send(activeId, env)}
            onTyping={() => notifyTyping(activeId)}
            onStartCall={() => (activeGroup ? startGroupCall(activeId) : startCall(activeId))}
            callBusy={call.status !== 'idle'}
            onReact={(msgId, emoji) => react(activeId, msgId, emoji)}
            onDeleteMe={(msgId) => deleteForMe(activeId, msgId)}
            onDeleteAll={(msgId) => deleteForAll(activeId, msgId)}
            onForward={(msg) => setForwarding(msg)}
            onLeaveGroup={() => { leaveGroup(activeId); setActiveId(null) }}
            onDeleteGroup={() => { deleteGroup(activeId); setActiveId(null) }}
            onAddMembers={() => setAddingTo(activeId)}
            onBlock={(id) => { blockContact(id); setActiveId(null) }}
            onUnblock={(id) => unblockContact(id)}
          />
        ) : (
          <section className="thread placeholder">
            <div className="empty">
              <div className="empty-glyph">{Icon.lock}</div>
              <p>Select a chat.</p>
              <p className="empty-sub">Every conversation gets its own encryption keys.</p>
            </div>
          </section>
        )}
      </main>

      {creatingGroup && (
        <NewGroupModal contacts={contacts.filter(c => c.status === 'accepted')} onCreate={createGroup} onClose={() => setCreatingGroup(false)} />
      )}
      {addingTo && (
        <MemberPicker
          title="Add members"
          contacts={contacts.filter(
            (c) => c.status === 'accepted' && !groups.find((g) => g.id === addingTo)?.members.some((m) => m.id === c.id)
          )}
          onPick={(ids) => inviteToGroup(addingTo, ids)}
          onClose={() => setAddingTo(null)}
        />
      )}
      {forwarding && (
        <ForwardPicker
          rows={sidebarRows}
          excludeId={activeId}
          onPick={(targetId) => forward(targetId, forwarding)}
          onClose={() => setForwarding(null)}
        />
      )}

      {showProfile && (
        <ProfileSettingsModal
          user={myProfile || { name, username }}
          socket={socketRef.current}
          blockedContacts={contacts.filter(c => c.status === 'blocked' && c.isRequester)}
          unblockContact={unblockContact}
          onUpdateProfile={(profile) => {
            socketRef.current?.emit('update-profile', profile)
          }}
          onClose={(updatedProfile) => {
            setShowProfile(false)
            if (updatedProfile?.name && updatedProfile.name !== name) {
              localStorage.setItem('sable-name', updatedProfile.name)
              if (updatedProfile.username) {
                localStorage.setItem('sable-username', updatedProfile.username)
              }
              // It will update in Shell but wait, App needs to know the name changed.
              // We could force a reload, or let App state trickle down.
              // For now, App relies on localStorage mostly.
            }
          }}
        />
      )}

      {call.status === 'incoming' && (
        <IncomingCall
          title={call.groupId ? groups.find((g) => g.id === call.groupId)?.name ?? 'Group call' : contacts.find((c) => c.id === call.peerId)?.name ?? 'Unknown'}
          subtitle={call.mode === 'group' ? `${call.callerName ?? 'Someone'} is starting a group call` : 'incoming video call'}
          isGroup={call.mode === 'group'}
          onAccept={() => {
            accept()
            setActiveId(call.groupId ?? call.peerId)
          }}
          onDecline={decline}
        />
      )}

      {authError && (
        <ConfirmModal
          title="Authentication Error"
          message={authError}
          confirmText="OK"
          danger={true}
          onConfirm={() => onSignOut()}
          onCancel={() => onSignOut()}
        />
      )}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(() => {
    const name = localStorage.getItem('sable-name')
    const username = localStorage.getItem('sable-username')
    return name ? { name, username } : null
  })

  if (!session) return <Welcome onEnter={setSession} />
  return (
    <Shell
      name={session.name}
      username={session.username}
      onSignOut={() => {
        localStorage.removeItem('sable-name')
        localStorage.removeItem('sable-username')
        setSession(null)
      }}
    />
  )
}
