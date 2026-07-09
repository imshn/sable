import { useEffect, useRef, useState } from 'react'
import { useChat } from './useChat.js'
import { useCall } from './useCall.js'
import { Icon } from './icons.jsx'
import { Thread, callLogText, Linkified } from './Thread.jsx'

function Welcome({ onEnter }) {
  const [name, setName] = useState(localStorage.getItem('sable-name') ?? '')

  const submit = (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    localStorage.setItem('sable-name', trimmed)
    onEnter(trimmed)
  }

  return (
    <div className="lobby">
      <section className="lobby-brand">
        <div className="wordmark">
          <span className="wordmark-glyph">{Icon.lock}</span>
          sable
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
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="How others will see you"
            maxLength={32}
            autoComplete="off"
            autoFocus
          />
          <p className="hint">Anyone online can find you by name and start an encrypted chat.</p>
          <button type="submit" className="primary" disabled={!name.trim()}>
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
    if (body.voice) return 'Voice message'
    if (body.mime?.startsWith('image/')) return 'Photo'
    if (body.mime?.startsWith('video/')) return 'Video'
    if (body.mime?.startsWith('audio/')) return 'Audio'
    return body.name
  }
  return body.text
}

function Sidebar({ name, rows, convos, activeId, onSelect, onNewGroup, safetyCode, connected, onSignOut }) {
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
          <button className="icon-btn subtle" aria-label="New group" title="New group" onClick={onNewGroup}>
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
function Video({ stream, muted, className, allowUnmute, label }) {
  const ref = useRef(null)
  const [blocked, setBlocked] = useState(false)

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

  return (
    <div className={`video-wrap ${className ?? ''}`}>
      <video ref={ref} autoPlay playsInline muted={muted} />
      {label && <span className="video-label">{label}</span>}
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

function CallOverlay({
  call, title, names, localStream, remoteStreams, micOn, camOn, sharing, sharers,
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
        <div className="call-main">
          {presenting && stageStream ? (
            <>
              <Video
                stream={stageStream}
                muted={sharing}
                className="stage-video"
                allowUnmute={!sharing}
                label={sharing ? 'You are presenting' : `${names(remoteSharer)} is presenting`}
              />
              <div className="filmstrip">
                {stripRemotes.map(([peerId, stream]) => (
                  <Video key={peerId} stream={stream} className="strip-tile" label={names(peerId)} />
                ))}
                {!sharing && <Video stream={localStream} muted className={`strip-tile ${camOn ? '' : 'dim'}`} label="you" />}
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
                <Video key={peerId} stream={stream} className="remote-video" allowUnmute label={names(peerId)} />
              ))}
            </div>
          )}
          {!presenting && <Video stream={localStream} muted className={`local-video ${camOn ? '' : 'off'}`} />}
          <div className="call-topbar">
            <span className="safety-icon">{Icon.lock}</span>
            {title}
            <span className="call-note">{sharing ? 'sharing your screen' : 'peer-to-peer, encrypted'}</span>
          </div>
          {toast && !chatOpen && (
            <button className="chat-toast" onClick={() => { setChatOpen(true); setToast(null) }}>
              <strong>{toast.name}</strong> {toast.text}
            </button>
          )}
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
                  <div className="drawer invite-drawer" role="menu">
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

function Shell({ name, onSignOut }) {
  const {
    clientId, contacts, groups, convos, safetyCode, connected,
    send, react, deleteForAll, deleteForMe, addLocalEntry,
    createGroup, deleteGroup, leaveGroup, inviteToGroup,
    notifyTyping, markRead, socketRef,
  } = useChat(name)
  const {
    call, localStream, remoteStreams, micOn, camOn, sharing, sharers,
    startCall, startGroupCall, accept, decline, hangup, toggleMic, toggleCam, toggleShare, inviteToCall,
  } = useCall(socketRef, (target, log) => addLocalEntry(target, { t: 'call', ...log }))
  const [activeId, setActiveId] = useState(null)
  const [forwarding, setForwarding] = useState(null)
  const [groupModal, setGroupModal] = useState(false)
  const [addingTo, setAddingTo] = useState(null) // groupId being extended

  // merged sidebar rows: groups + contacts, most recent first
  const rows = [
    ...groups.map((g) => ({ id: g.id, name: g.name, isGroup: true, memberCount: g.members.length })),
    ...contacts.map((c) => ({ id: c.id, name: c.name, isGroup: false })),
  ].sort((a, b) => (convos[b.id]?.lastTs ?? 0) - (convos[a.id]?.lastTs ?? 0) || a.name.localeCompare(b.name))

  // resolve the open thread target (direct contact or group)
  const activeContact = contacts.find((c) => c.id === activeId)
  const activeGroup = groups.find((g) => g.id === activeId)
  const [lastPeer, setLastPeer] = useState(null)
  useEffect(() => {
    if (activeContact) setLastPeer(activeContact)
  }, [activeContact])

  const target = activeGroup
    ? {
        id: activeGroup.id,
        name: activeGroup.name,
        online: true,
        isGroup: true,
        members: activeGroup.members,
        mine: activeGroup.owner === clientId,
      }
    : activeContact
      ? { ...activeContact, isGroup: false }
      : activeId && lastPeer?.id === activeId
        ? { ...lastPeer, online: false, isGroup: false }
        : null

  const activeConvo = activeId ? convos[activeId] : null
  // the thread behind an active call overlay isn't visible — let the in-call
  // chat panel (onReadChat) own read-marking during calls
  const inCall = call.status !== 'idle'
  useEffect(() => {
    if (activeId && activeConvo?.unread && !inCall) markRead(activeId)
  }, [activeId, activeConvo, markRead, inCall])

  const nameOf = (id) =>
    contacts.find((c) => c.id === id)?.name ??
    groups.flatMap((g) => g.members).find((m) => m.id === id)?.name ??
    'Unknown'

  const callTitle = call.groupId ? groups.find((g) => g.id === call.groupId)?.name ?? 'Group call' : nameOf(call.peerId)

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

  return (
    <div className={`shell ${activeId ? 'thread-open' : ''}`}>
      <Sidebar
        name={name}
        rows={rows}
        convos={convos}
        activeId={activeId}
        onSelect={setActiveId}
        onNewGroup={() => setGroupModal(true)}
        safetyCode={safetyCode}
        connected={connected}
        onSignOut={onSignOut}
      />
      {target ? (
        <Thread
          key={target.id}
          target={target}
          convo={activeConvo}
          clientId={clientId}
          onBack={() => setActiveId(null)}
          onSend={(env) => send(target.id, env)}
          onTyping={() => notifyTyping(target.id)}
          onStartCall={() => (target.isGroup ? startGroupCall(target.id) : startCall(target.id))}
          callBusy={call.status !== 'idle'}
          onReact={(msgId, emoji) => react(target.id, msgId, emoji)}
          onDeleteMe={(msgId) => deleteForMe(target.id, msgId)}
          onDeleteAll={(msgId) => deleteForAll(target.id, msgId)}
          onForward={(msg) => setForwarding(msg)}
          onLeaveGroup={() => { leaveGroup(target.id); setActiveId(null) }}
          onDeleteGroup={() => { deleteGroup(target.id); setActiveId(null) }}
          onAddMembers={() => setAddingTo(target.id)}
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

      {groupModal && (
        <NewGroupModal contacts={contacts} onCreate={createGroup} onClose={() => setGroupModal(false)} />
      )}
      {addingTo && (
        <MemberPicker
          title="Add members"
          contacts={contacts.filter(
            (c) => !groups.find((g) => g.id === addingTo)?.members.some((m) => m.id === c.id)
          )}
          onPick={(ids) => inviteToGroup(addingTo, ids)}
          onClose={() => setAddingTo(null)}
        />
      )}
      {forwarding && (
        <ForwardPicker
          rows={rows}
          excludeId={target?.id}
          onPick={(targetId) => forward(targetId, forwarding)}
          onClose={() => setForwarding(null)}
        />
      )}
      {call.status === 'incoming' && (
        <IncomingCall
          title={callTitle}
          subtitle={call.mode === 'group' ? `${call.callerName ?? 'Someone'} is starting a group call` : 'incoming video call'}
          isGroup={call.mode === 'group'}
          onAccept={() => {
            accept()
            setActiveId(call.groupId ?? call.peerId)
          }}
          onDecline={decline}
        />
      )}
      {(call.status === 'outgoing' || call.status === 'active') && (
        <CallOverlay
          call={call}
          title={callTitle}
          names={nameOf}
          localStream={localStream}
          remoteStreams={remoteStreams}
          micOn={micOn}
          camOn={camOn}
          sharing={sharing}
          sharers={sharers}
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
      )}
    </div>
  )
}

export default function App() {
  const [name, setName] = useState(null)

  if (!name) return <Welcome onEnter={setName} />
  return (
    <Shell
      name={name}
      onSignOut={() => {
        localStorage.removeItem('sable-name')
        setName(null)
      }}
    />
  )
}
