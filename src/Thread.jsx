import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { b64encode } from './crypto.js'

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const initials = (n) => n.trim().slice(0, 2).toUpperCase()
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const MAX_FILE = 15 * 1024 * 1024

const fmtSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const callLogText = (body, peerName) =>
  ({
    ended: `Video call · ${fmtDur(body.dur ?? 0)}`,
    missed: 'Missed video call',
    declined: `${peerName} declined the call`,
    cancelled: 'Video call ended',
    'media-error': 'Could not access camera or microphone',
  })[body.kind] ?? 'Video call'

const isMedia = (m) =>
  !m.deleted && m.body?.t === 'file' && (m.body.mime?.startsWith('image/') || m.body.mime?.startsWith('video/'))

// URLs in text become safe anchors
const URL_RE = /(https?:\/\/[^\s<>"']+)/g
export function Linkified({ text }) {
  const parts = text.split(URL_RE)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="msg-link">
        {part}
      </a>
    ) : (
      part
    )
  )
}

// OG-card preview for the first link in a message, WhatsApp style.
// The relay's /preview endpoint does the fetch (CORS blocks doing it here).
const RELAY_BASE = import.meta.env.VITE_RELAY_URL ?? ''
const previewCache = new Map()

function LinkPreview({ url }) {
  const [data, setData] = useState(previewCache.get(url))

  useEffect(() => {
    if (previewCache.has(url)) {
      setData(previewCache.get(url))
      return
    }
    let alive = true
    fetch(`${RELAY_BASE}/preview?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((d) => {
        previewCache.set(url, d)
        if (alive) setData(d)
      })
      .catch(() => previewCache.set(url, {}))
    return () => {
      alive = false
    }
  }, [url])

  if (!data?.title && !data?.image) return null
  return (
    <a className="link-preview" href={url} target="_blank" rel="noopener noreferrer">
      {data.image && <img src={data.image} alt="" loading="lazy" onError={(e) => { e.target.style.display = 'none' }} />}
      <span className="lp-body">
        {data.title && <span className="lp-title">{data.title}</span>}
        {data.description && <span className="lp-desc">{data.description}</span>}
        <span className="lp-domain">{new URL(url).hostname}</span>
      </span>
    </a>
  )
}

function MessageBody({ body, onOpenMedia }) {
  if (body.t === 'loc') {
    const { lat, lng } = body
    const d = 0.004
    return (
      <span className="loc">
        <iframe
          title="Shared location"
          src={`https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}`}
          loading="lazy"
        />
        <a href={`https://maps.google.com/?q=${lat},${lng}`} target="_blank" rel="noreferrer">
          {Icon.pin} Open location
        </a>
      </span>
    )
  }
  if (body.t === 'file') {
    if (body.voice || body.mime?.startsWith('audio/'))
      return (
        <span className={`audio-msg ${body.voice ? 'voice' : ''}`}>
          {body.voice && <span className="voice-icon">{Icon.mic}</span>}
          <audio src={body.url} controls />
        </span>
      )
    if (body.mime?.startsWith('image/'))
      return (
        <button type="button" className="media-btn" onClick={onOpenMedia} aria-label={`View ${body.name}`}>
          <img className="media" src={body.url} alt={body.name} />
        </button>
      )
    if (body.mime?.startsWith('video/'))
      return (
        <button type="button" className="media-btn" onClick={onOpenMedia} aria-label={`Play ${body.name}`}>
          <video className="media" src={body.url} muted preload="metadata" />
          <span className="play-badge">{Icon.video}</span>
        </button>
      )
    return (
      <a className="file-chip" href={body.url} download={body.name}>
        <span className="file-chip-icon">{Icon.file}</span>
        <span className="file-chip-body">
          <span className="file-chip-name">{body.name}</span>
          <span className="file-chip-size">{fmtSize(body.size)}</span>
        </span>
        <span className="file-chip-dl">{Icon.download}</span>
      </a>
    )
  }
  const firstUrl = body.text.match(URL_RE)?.[0]
  if (!firstUrl) return body.text
  return (
    <span className="text-with-preview">
      <LinkPreview url={firstUrl} />
      <span><Linkified text={body.text} /></span>
    </span>
  )
}

function ContextMenu({ menu, onClose, onReact, onCopy, onForward, onDeleteMe, onDeleteAll }) {
  const ref = useRef(null)

  useEffect(() => {
    const close = (e) => {
      if (!ref.current?.contains(e.target)) onClose()
    }
    const esc = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const { msg, x, y } = menu
  const style = {
    left: Math.min(x, window.innerWidth - 240),
    top: Math.min(y, window.innerHeight - 260),
  }

  return (
    <div className="ctx-menu" style={style} ref={ref} role="menu">
      <div className="ctx-reactions">
        {REACTIONS.map((e) => (
          <button
            key={e}
            className={`ctx-react ${msg.reactions?.me === e ? 'mine' : ''}`}
            onClick={() => { onReact(msg.reactions?.me === e ? null : e); onClose() }}
            aria-label={`React ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
      {msg.body.t === 'text' && (
        <button className="ctx-item" role="menuitem" onClick={() => { onCopy(); onClose() }}>
          {Icon.copy} Copy
        </button>
      )}
      <button className="ctx-item" role="menuitem" onClick={() => { onForward(); onClose() }}>
        {Icon.forward} Forward
      </button>
      <button className="ctx-item" role="menuitem" onClick={() => { onDeleteMe(); onClose() }}>
        {Icon.trash} Delete for me
      </button>
      {msg.kind === 'self' && (
        <button className="ctx-item danger" role="menuitem" onClick={() => { onDeleteAll(); onClose() }}>
          {Icon.trash} Delete for everyone
        </button>
      )}
    </div>
  )
}

function Lightbox({ items, index, onClose, onNav }) {
  const item = items[index]

  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onNav(-1)
      if (e.key === 'ArrowRight') onNav(1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose, onNav])

  if (!item) return null
  return (
    <div className="lightbox" role="dialog" aria-label="Media viewer" onClick={onClose}>
      <div className="lightbox-top" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{item.body.name}</span>
        <a className="icon-btn subtle light" href={item.body.url} download={item.body.name} aria-label="Download">
          {Icon.download}
        </a>
        <button className="icon-btn subtle light" aria-label="Close viewer" onClick={onClose}>
          {Icon.x}
        </button>
      </div>

      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {index > 0 && (
          <button className="lb-nav prev" aria-label="Previous" onClick={() => onNav(-1)}>
            {Icon.chevronL}
          </button>
        )}
        {item.body.mime.startsWith('image/') ? (
          <img key={item.id} src={item.body.url} alt={item.body.name} />
        ) : (
          <video key={item.id} src={item.body.url} controls autoPlay />
        )}
        {index < items.length - 1 && (
          <button className="lb-nav next" aria-label="Next" onClick={() => onNav(1)}>
            {Icon.chevronR}
          </button>
        )}
      </div>

      <div className="lightbox-thumbs" onClick={(e) => e.stopPropagation()}>
        {items.map((it, i) => (
          <button
            key={it.id}
            className={`lb-thumb ${i === index ? 'current' : ''}`}
            onClick={() => onNav(i - index)}
            aria-label={`Media ${i + 1}`}
          >
            {it.body.mime.startsWith('image/') ? (
              <img src={it.body.url} alt="" />
            ) : (
              <video src={it.body.url} muted preload="metadata" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

function LocationModal({ onSend, onClose }) {
  const [pos, setPos] = useState(null)
  const [manual, setManual] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (p) => setPos({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }),
      () => setError('Could not read your position — paste coordinates or a maps link below'),
      { enableHighAccuracy: true, timeout: 8000 }
    )
  }, [])

  const parseManual = () => {
    const m = manual.match(/(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/)
    if (!m) return setError('Could not read coordinates from that')
    setError('')
    setPos({ lat: +m[1], lng: +m[2] })
  }

  const d = 0.004
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Share location" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Share location</h3>
          <button className="icon-btn subtle" aria-label="Close" onClick={onClose}>{Icon.x}</button>
        </header>
        {pos ? (
          <iframe
            className="modal-map"
            title="Location preview"
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${pos.lng - d},${pos.lat - d},${pos.lng + d},${pos.lat + d}&layer=mapnik&marker=${pos.lat},${pos.lng}`}
          />
        ) : (
          <div className="modal-map placeholder">Locating…</div>
        )}
        <div className="modal-row">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), parseManual())}
            placeholder="Or paste coordinates / maps link"
            aria-label="Coordinates or maps link"
          />
          <button type="button" className="icon-btn" aria-label="Preview coordinates" onClick={parseManual}>
            {Icon.crosshair}
          </button>
        </div>
        {error && <p className="modal-error">{error}</p>}
        <button className="primary" disabled={!pos} onClick={() => { onSend(pos); onClose() }}>
          Send this location
          <span className="btn-icon">{Icon.pin}</span>
        </button>
      </div>
    </div>
  )
}

function Composer({ target, onSend, onTyping }) {
  const [draft, setDraft] = useState('')
  const [rec, setRec] = useState(null)
  const [recElapsed, setRecElapsed] = useState(0)
  const [note, setNote] = useState('')
  const [menu, setMenu] = useState(null)
  const [locModal, setLocModal] = useState(false)
  // three static inputs with fixed accepts — mutating one input's accept right
  // before .click() is flaky in Safari, so each category gets its own element
  const photosRef = useRef(null)
  const audioRef = useRef(null)
  const docsRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    setDraft('')
    setNote('')
    setMenu(null)
    inputRef.current?.focus()
  }, [target.id])

  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => setRecElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [rec])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menu])

  const flash = (text) => {
    setNote(text)
    setTimeout(() => setNote(''), 3000)
  }

  const submit = (e) => {
    e.preventDefault()
    if (!draft.trim()) return
    onSend({ t: 'text', text: draft.trim() })
    setDraft('')
  }

  const sendFiles = async (files) => {
    for (const f of [...files].slice(0, 5)) {
      if (f.size > MAX_FILE) {
        flash(`${f.name} is over 15 MB`)
        continue
      }
      const buf = await f.arrayBuffer()
      onSend({
        t: 'file',
        name: f.name,
        mime: f.type || 'application/octet-stream',
        size: f.size,
        data: b64encode(buf),
      })
    }
  }

  const startVoice = async () => {
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return flash('Microphone unavailable')
    }
    const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()))
    const chunks = []
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      if (recorder.cancelled) return
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      const buf = await blob.arrayBuffer()
      onSend({ t: 'file', voice: true, name: 'voice-note.webm', mime: blob.type, size: blob.size, data: b64encode(buf) })
    }
    recorder.start()
    setRecElapsed(0)
    setRec(recorder)
  }

  const stopVoice = (cancelled) => {
    if (!rec) return
    rec.cancelled = cancelled
    rec.stop()
    setRec(null)
  }

  const fileInput = (ref, accept) => (
    <input
      ref={ref}
      type="file"
      accept={accept || undefined}
      multiple
      style={{ display: 'none' }}
      onChange={(e) => { sendFiles(e.target.files); e.target.value = '' }}
    />
  )

  if (rec) {
    return (
      <div className="composer recording">
        <button type="button" className="icon-btn" aria-label="Cancel recording" onClick={() => stopVoice(true)}>
          {Icon.x}
        </button>
        <span className="rec-status">
          <span className="rec-dot" aria-hidden="true" />
          recording <code>{Math.floor(recElapsed / 60)}:{String(recElapsed % 60).padStart(2, '0')}</code>
        </span>
        <button type="button" className="primary send" aria-label="Send voice message" onClick={() => stopVoice(false)}>
          {Icon.send}
        </button>
      </div>
    )
  }

  return (
    <form className="composer" onSubmit={submit}>
      {note && <span className="composer-note" role="status">{note}</span>}
      {fileInput(photosRef, 'image/*,video/*')}
      {fileInput(audioRef, 'audio/*')}
      {fileInput(docsRef, '')}

      <div className="composer-anchor">
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="Attach"
          aria-expanded={menu === 'attach'}
          onClick={(e) => { e.stopPropagation(); setMenu(menu === 'attach' ? null : 'attach') }}
        >
          {Icon.clip}
        </button>
        {menu === 'attach' && (
          <div className="drawer" role="menu" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="drawer-item" role="menuitem" onClick={() => { photosRef.current?.click(); setMenu(null) }}>
              <span className="drawer-glyph photos">{Icon.image}</span>
              Photos &amp; videos
            </button>
            <button type="button" className="drawer-item" role="menuitem" onClick={() => { audioRef.current?.click(); setMenu(null) }}>
              <span className="drawer-glyph audio">{Icon.music}</span>
              Audio
            </button>
            <button type="button" className="drawer-item" role="menuitem" onClick={() => { docsRef.current?.click(); setMenu(null) }}>
              <span className="drawer-glyph docs">{Icon.file}</span>
              Document
            </button>
          </div>
        )}
      </div>

      <div className="composer-anchor">
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="Share location"
          aria-expanded={menu === 'location'}
          onClick={(e) => { e.stopPropagation(); setMenu(menu === 'location' ? null : 'location') }}
        >
          {Icon.pin}
        </button>
        {menu === 'location' && (
          <div className="drawer" role="menu" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="drawer-item"
              role="menuitem"
              onClick={() => {
                setMenu(null)
                if (!navigator.geolocation) return flash('Location is not available here')
                navigator.geolocation.getCurrentPosition(
                  (p) => onSend({ t: 'loc', lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }),
                  () => flash('Could not get your location'),
                  { enableHighAccuracy: true, timeout: 10000 }
                )
              }}
            >
              <span className="drawer-glyph loc-glyph">{Icon.crosshair}</span>
              Send current location
            </button>
            <button type="button" className="drawer-item" role="menuitem" onClick={() => { setMenu(null); setLocModal(true) }}>
              <span className="drawer-glyph maps">{Icon.globe}</span>
              Choose on map
            </button>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); onTyping() }}
        placeholder={target.online || target.isGroup ? 'Write privately…' : `${target.name} is offline — they'll get it when back`}
        aria-label="Message"
        autoComplete="off"
      />
      {draft.trim() ? (
        <button type="submit" className="primary send" aria-label="Send message">
          {Icon.send}
        </button>
      ) : (
        <button type="button" className="primary send" aria-label="Record voice message" onClick={startVoice}>
          {Icon.mic}
        </button>
      )}

      {locModal && (
        <LocationModal onClose={() => setLocModal(false)} onSend={(pos) => onSend({ t: 'loc', ...pos })} />
      )}
    </form>
  )
}

// target: { id, name, online, isGroup, members?, owner?, mine? }
export function Thread({
  target, convo, clientId, onBack, onSend, onTyping, onStartCall, callBusy,
  onReact, onDeleteMe, onDeleteAll, onForward, onLeaveGroup, onDeleteGroup, onAddMembers,
}) {
  const scrollRef = useRef(null)
  const [menu, setMenu] = useState(null)
  const [headMenu, setHeadMenu] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const messages = convo?.messages ?? []
  const mediaList = messages.filter(isMedia)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, convo?.typing])

  useEffect(() => {
    if (!headMenu) return
    const close = () => setHeadMenu(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [headMenu])

  const openMenu = (e, m) => {
    if (m.deleted || m.kind === 'call' || m.kind === 'sys' || m.kind === 'error') return
    e.preventDefault()
    setMenu({ msg: m, x: e.clientX, y: e.clientY })
  }

  const subtitle = target.isGroup
    ? target.members.map((m) => (m.id === clientId ? 'you' : m.name)).join(', ')
    : target.online
      ? convo?.typing
        ? 'typing…'
        : 'online'
      : 'offline'

  return (
    <section className="thread">
      <header className="chat-header">
        <div className="chat-title">
          <button className="icon-btn back-btn" aria-label="Back to chats" onClick={onBack}>
            {Icon.back}
          </button>
          <span className={`avatar ${target.isGroup ? 'group' : ''}`} aria-hidden="true">
            {target.isGroup ? Icon.users : initials(target.name)}
          </span>
          <div className="chat-title-text">
            <div className="room-name">{target.name}</div>
            <div className="presence">{convo?.typing && target.isGroup ? `${convo.typing} is typing…` : subtitle}</div>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="icon-btn"
            aria-label={`Video call ${target.name}`}
            title="Video call"
            disabled={!target.online || callBusy}
            onClick={onStartCall}
          >
            {Icon.video}
          </button>
          {target.isGroup && (
            <div className="composer-anchor">
              <button
                className="icon-btn"
                aria-label="Group options"
                aria-expanded={headMenu}
                onClick={(e) => { e.stopPropagation(); setHeadMenu(!headMenu) }}
              >
                {Icon.dots}
              </button>
              {headMenu && (
                <div className="drawer head-drawer" role="menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="drawer-item" role="menuitem" onClick={() => { setHeadMenu(false); onAddMembers() }}>
                    <span className="drawer-glyph photos">{Icon.userPlus}</span>
                    Add members
                  </button>
                  <button type="button" className="drawer-item" role="menuitem" onClick={() => { setHeadMenu(false); onLeaveGroup() }}>
                    <span className="drawer-glyph docs">{Icon.signout}</span>
                    Leave group
                  </button>
                  {target.mine && (
                    <button type="button" className="drawer-item danger" role="menuitem" onClick={() => { setHeadMenu(false); onDeleteGroup() }}>
                      <span className="drawer-glyph danger-glyph">{Icon.trash}</span>
                      Delete group
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="e2e-note">
            <span className="safety-icon">{Icon.lock}</span>
            end-to-end encrypted
          </div>
        </div>
      </header>

      <main className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-glyph">{Icon.lock}</div>
            <p>Say something{target.isGroup ? '' : ` to ${target.name}`}.</p>
            <p className="empty-sub">
              {target.isGroup
                ? 'Every message is encrypted separately for each member.'
                : 'Messages and files are encrypted for their device before leaving yours.'}
            </p>
          </div>
        )}
        {messages.map((m, i) => {
          if (m.kind === 'sys') {
            return <div key={m.id} className="sys-line">{m.body.text}</div>
          }
          if (m.kind === 'call') {
            return (
              <div key={m.id} className={`call-log ${m.body.kind === 'missed' ? 'missed' : ''}`}>
                {m.body.kind === 'missed' || m.body.kind === 'declined' ? Icon.videoOff : Icon.video}
                {callLogText(m.body, target.name)}
                <time>{timeFmt.format(m.ts)}</time>
              </div>
            )
          }
          const prev = messages[i - 1]
          const grouped = prev && prev.kind === m.kind && prev.from === m.from && m.ts - prev.ts < 120000
          const rich = m.body.t !== 'text' && !m.deleted
          const reactions = Object.values(m.reactions ?? {})
          return (
            <div
              key={m.id}
              className={`msg ${m.kind === 'self' ? 'self' : 'peer'} ${grouped ? 'grouped' : ''} ${reactions.length ? 'reacted' : ''}`}
              onContextMenu={(e) => openMenu(e, m)}
            >
              <div className={`bubble ${rich ? 'rich' : ''}`}>
                {target.isGroup && m.kind === 'peer' && !grouped && (
                  <span className="sender-name">{m.name}</span>
                )}
                {m.body.fwd && !m.deleted && <span className="fwd-tag">{Icon.forward} forwarded</span>}
                {m.deleted ? (
                  <em className="decrypt-error">This message was deleted</em>
                ) : m.kind === 'error' ? (
                  <em className="decrypt-error">{m.body.text}</em>
                ) : (
                  <MessageBody
                    body={m.body}
                    onOpenMedia={() => setLightbox(mediaList.findIndex((x) => x.id === m.id))}
                  />
                )}
                <span className="bubble-meta">
                  <time>{timeFmt.format(m.ts)}</time>
                  {m.kind === 'self' && !m.deleted && (
                    <span className={`ticks ${m.status === 'delivered' ? 'delivered' : ''}`} aria-label={m.status}>
                      {m.status === 'delivered' ? Icon.checkAll : Icon.check}
                    </span>
                  )}
                </span>
              </div>
              {reactions.length > 0 && (
                <button
                  className="reaction-chips"
                  onClick={() => m.reactions?.me && onReact(m.id, null)}
                  title={m.reactions?.me ? 'Remove your reaction' : ''}
                >
                  {[...new Set(reactions)].map((e) => (
                    <span key={e}>{e}</span>
                  ))}
                  {reactions.length > 1 && <span className="reaction-count">{reactions.length}</span>}
                </button>
              )}
            </div>
          )
        })}
        {convo?.typing && (
          <div className="typing" aria-live="polite">
            <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {convo.typing} is typing
          </div>
        )}
      </main>

      <Composer target={target} onSend={onSend} onTyping={onTyping} />

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onReact={(emoji) => onReact(menu.msg.id, emoji)}
          onCopy={() => navigator.clipboard?.writeText(menu.msg.body.text ?? '')}
          onForward={() => onForward(menu.msg)}
          onDeleteMe={() => onDeleteMe(menu.msg.id)}
          onDeleteAll={() => onDeleteAll(menu.msg.id)}
        />
      )}
      {lightbox !== null && lightbox >= 0 && (
        <Lightbox
          items={mediaList}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onNav={(delta) => setLightbox((i) => Math.max(0, Math.min(mediaList.length - 1, i + delta)))}
        />
      )}
    </section>
  )
}
