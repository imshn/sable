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

// short description of a message for reply quotes / the reply bar
export const replyPreviewOf = (m) => {
  if (m.deleted) return 'Message deleted'
  const b = m.body
  if (b.t === 'loc') return 'Location'
  if (b.t === 'file') {
    if (b.caption) return b.caption.slice(0, 120)
    if (b.voice) return 'Voice message'
    if (b.mime?.startsWith('image/')) return 'Photo'
    if (b.mime?.startsWith('video/')) return 'Video'
    if (b.mime?.startsWith('audio/')) return 'Audio'
    return b.name
  }
  return (b.text ?? '').slice(0, 120)
}

const isMedia = (m) =>
  !m.deleted && m.body?.t === 'file' && (m.body.mime?.startsWith('image/') || m.body.mime?.startsWith('video/'))

// file (+ optional caption) -> encrypted-envelope payload
async function fileEnvelope(file, caption) {
  const buf = await file.arrayBuffer()
  return {
    t: 'file',
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    data: b64encode(buf),
    ...(caption ? { caption } : {}),
  }
}

const DRAW_COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#f9fafb']

// WhatsApp-style pre-send preview: caption for any file, plus draw / rotate /
// crop / undo for images (canvas pipeline; original bytes kept if untouched).
function SendPreview({ file, remaining, onSend, onCancel }) {
  const isImage = file.type.startsWith('image/')
  const isVideo = file.type.startsWith('video/')
  const [caption, setCaption] = useState('')
  const [tool, setTool] = useState(null) // null | 'draw' | 'crop'
  const [color, setColor] = useState(DRAW_COLORS[0])
  const [canUndo, setCanUndo] = useState(false)
  const [cropReady, setCropReady] = useState(false)
  const canvasRef = useRef(null)
  const mediaUrl = useRef(null)
  const history = useRef([])
  const edited = useRef(false)
  const drawing = useRef(false)
  const cropStart = useRef(null)
  const cropRect = useRef(null)
  const cropBase = useRef(null) // ImageData under the marquee preview

  if (!mediaUrl.current) mediaUrl.current = URL.createObjectURL(file)

  useEffect(() => {
    if (!isImage) return
    const img = new Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
    }
    img.src = mediaUrl.current
    return () => URL.revokeObjectURL(mediaUrl.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const snapshot = () => {
    const c = canvasRef.current
    history.current.push({ w: c.width, h: c.height, data: c.getContext('2d').getImageData(0, 0, c.width, c.height) })
    if (history.current.length > 10) history.current.shift()
    edited.current = true
    setCanUndo(true)
  }

  const undo = () => {
    const prev = history.current.pop()
    if (!prev) return
    const c = canvasRef.current
    c.width = prev.w
    c.height = prev.h
    c.getContext('2d').putImageData(prev.data, 0, 0)
    setCanUndo(history.current.length > 0)
    cancelCrop()
  }

  const rotate = () => {
    snapshot()
    const c = canvasRef.current
    const tmp = document.createElement('canvas')
    tmp.width = c.height
    tmp.height = c.width
    const t = tmp.getContext('2d')
    t.translate(tmp.width / 2, tmp.height / 2)
    t.rotate(Math.PI / 2)
    t.drawImage(c, -c.width / 2, -c.height / 2)
    c.width = tmp.width
    c.height = tmp.height
    c.getContext('2d').drawImage(tmp, 0, 0)
    cancelCrop()
  }

  const canvasPoint = (e) => {
    const c = canvasRef.current
    const r = c.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(c.width, (e.clientX - r.left) * (c.width / r.width))),
      y: Math.max(0, Math.min(c.height, (e.clientY - r.top) * (c.height / r.height))),
    }
  }

  const onPointerDown = (e) => {
    if (!tool) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = canvasPoint(e)
    const ctx = canvasRef.current.getContext('2d')
    if (tool === 'draw') {
      snapshot()
      drawing.current = true
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(4, canvasRef.current.width / 160)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
    } else if (tool === 'crop') {
      const c = canvasRef.current
      if (!cropBase.current) cropBase.current = ctx.getImageData(0, 0, c.width, c.height)
      cropStart.current = p
      cropRect.current = null
      setCropReady(false)
    }
  }

  const onPointerMove = (e) => {
    if (!tool) return
    const p = canvasPoint(e)
    const c = canvasRef.current
    const ctx = c.getContext('2d')
    if (tool === 'draw' && drawing.current) {
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else if (tool === 'crop' && cropStart.current) {
      const s = cropStart.current
      const rect = {
        x: Math.round(Math.min(s.x, p.x)),
        y: Math.round(Math.min(s.y, p.y)),
        w: Math.round(Math.abs(p.x - s.x)),
        h: Math.round(Math.abs(p.y - s.y)),
      }
      cropRect.current = rect
      ctx.putImageData(cropBase.current, 0, 0)
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, c.width, c.height)
      // restore the selected region at full brightness
      ctx.putImageData(cropBase.current, 0, 0, rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = '#2dd4bf'
      ctx.lineWidth = Math.max(2, c.width / 400)
      ctx.setLineDash([8, 6])
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      ctx.setLineDash([])
    }
  }

  const onPointerUp = () => {
    if (tool === 'draw') drawing.current = false
    if (tool === 'crop' && cropRect.current && cropRect.current.w > 12 && cropRect.current.h > 12) {
      cropStart.current = null
      setCropReady(true)
    }
  }

  const cancelCrop = () => {
    if (cropBase.current && canvasRef.current) {
      const c = canvasRef.current
      if (cropBase.current.width === c.width && cropBase.current.height === c.height) {
        c.getContext('2d').putImageData(cropBase.current, 0, 0)
      }
    }
    cropBase.current = null
    cropRect.current = null
    cropStart.current = null
    setCropReady(false)
  }

  const applyCrop = () => {
    const rect = cropRect.current
    const base = cropBase.current
    if (!rect || !base) return
    snapshot()
    const c = canvasRef.current
    c.getContext('2d').putImageData(base, 0, 0) // clean image, no marquee
    const tmp = document.createElement('canvas')
    tmp.width = rect.w
    tmp.height = rect.h
    tmp.getContext('2d').drawImage(c, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    c.width = rect.w
    c.height = rect.h
    c.getContext('2d').drawImage(tmp, 0, 0)
    cropBase.current = null
    cropRect.current = null
    setCropReady(false)
    setTool(null)
  }

  const send = async () => {
    let out = file
    if (isImage && edited.current) {
      if (tool === 'crop') cancelCrop()
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      const blob = await new Promise((res) => canvasRef.current.toBlob(res, type, 0.92))
      out = new File([blob], file.name.replace(/\.\w+$/, type === 'image/png' ? '.png' : '.jpg'), { type })
    }
    onSend(out, caption.trim())
  }

  return (
    <div className="modal-backdrop">
      <div className="modal send-preview" role="dialog" aria-label="Send file">
        <header className="modal-head">
          <h3>{isImage ? 'Send photo' : isVideo ? 'Send video' : 'Send file'}{remaining > 0 ? ` (+${remaining} more)` : ''}</h3>
          <button className="icon-btn subtle" aria-label="Cancel" onClick={onCancel}>{Icon.x}</button>
        </header>

        {isImage ? (
          <>
            <div className={`edit-stage tool-${tool ?? 'none'}`}>
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            </div>
            <div className="edit-tools" role="toolbar" aria-label="Image editing">
              <button className={`icon-btn ${canUndo ? '' : 'disabled-look'}`} aria-label="Undo" title="Undo" onClick={undo} disabled={!canUndo}>
                {Icon.back}
              </button>
              <button className="icon-btn" aria-label="Rotate" title="Rotate 90°" onClick={rotate}>
                {Icon.rotate}
              </button>
              <button
                className={`icon-btn ${tool === 'draw' ? 'tool-active' : ''}`}
                aria-label="Draw"
                title="Draw"
                onClick={() => { cancelCrop(); setTool(tool === 'draw' ? null : 'draw') }}
              >
                {Icon.pen}
              </button>
              {tool === 'draw' &&
                DRAW_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch ${color === c ? 'picked' : ''}`}
                    style={{ background: c }}
                    aria-label={`Pen color ${c}`}
                    onClick={() => setColor(c)}
                  />
                ))}
              <button
                className={`icon-btn ${tool === 'crop' ? 'tool-active' : ''}`}
                aria-label="Crop"
                title="Crop"
                onClick={() => { if (tool === 'crop') { cancelCrop(); setTool(null) } else setTool('crop') }}
              >
                {Icon.crop}
              </button>
              {cropReady && (
                <button className="primary crop-apply" onClick={applyCrop}>
                  Apply crop
                </button>
              )}
            </div>
          </>
        ) : isVideo ? (
          <video className="preview-media" src={mediaUrl.current} controls />
        ) : (
          <div className="file-chip preview-chip">
            <span className="file-chip-icon">{Icon.file}</span>
            <span className="file-chip-body">
              <span className="file-chip-name">{file.name}</span>
              <span className="file-chip-size">{fmtSize(file.size)}</span>
            </span>
          </div>
        )}

        <form
          className="caption-row"
          onSubmit={(e) => { e.preventDefault(); send() }}
        >
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Add a caption…"
            aria-label="Caption"
            autoComplete="off"
            autoFocus={!isImage}
          />
          <button type="submit" className="primary send" aria-label="Send">
            {Icon.send}
          </button>
        </form>
      </div>
    </div>
  )
}

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
    const caption = body.caption ? (
      <span className="file-caption"><Linkified text={body.caption} /></span>
    ) : null
    if (body.voice || body.mime?.startsWith('audio/'))
      return (
        <>
          <span className={`audio-msg ${body.voice ? 'voice' : ''}`}>
            {body.voice && <span className="voice-icon">{Icon.mic}</span>}
            <audio src={body.url} controls />
          </span>
          {caption}
        </>
      )
    if (body.mime?.startsWith('image/'))
      return (
        <>
          <button type="button" className="media-btn" onClick={onOpenMedia} aria-label={`View ${body.name}`}>
            <img className="media" src={body.url} alt={body.name} />
          </button>
          {caption}
        </>
      )
    if (body.mime?.startsWith('video/'))
      return (
        <>
          <button type="button" className="media-btn" onClick={onOpenMedia} aria-label={`Play ${body.name}`}>
            <video className="media" src={body.url} muted preload="metadata" />
            <span className="play-badge">{Icon.video}</span>
          </button>
          {caption}
        </>
      )
    return (
      <>
        <a className="file-chip" href={body.url} download={body.name}>
          <span className="file-chip-icon">{Icon.file}</span>
          <span className="file-chip-body">
            <span className="file-chip-name">{body.name}</span>
            <span className="file-chip-size">{fmtSize(body.size)}</span>
          </span>
          <span className="file-chip-dl">{Icon.download}</span>
        </a>
        {caption}
      </>
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

function ContextMenu({ menu, onClose, onReact, onReply, onCopy, onForward, onDeleteMe, onDeleteAll }) {
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
      <button className="ctx-item" role="menuitem" onClick={() => { onReply(); onClose() }}>
        {Icon.reply} Reply
      </button>
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

function Composer({ target, onSend, onTyping, onPickFiles }) {
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

  const sendFiles = (files) => {
    const ok = [...files].slice(0, 5).filter((f) => {
      if (f.size > MAX_FILE) {
        flash(`${f.name} is over 15 MB`)
        return false
      }
      return true
    })
    if (ok.length) onPickFiles(ok)
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
  onReact, onDeleteMe, onDeleteAll, onForward, onLeaveGroup, onDeleteGroup, onAddMembers, onBlock,
}) {
  const scrollRef = useRef(null)
  const [menu, setMenu] = useState(null)
  const [headMenu, setHeadMenu] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [pending, setPending] = useState([]) // files awaiting caption/edit before send
  const [replyTo, setReplyTo] = useState(null) // { id, name, preview }
  const swipe = useRef(null)
  const dragDepth = useRef(0)
  const messages = convo?.messages ?? []
  const mediaList = messages.filter(isMedia)

  const queueFiles = (files) =>
    setPending((q) => [...q, ...[...files].filter((f) => f.size <= MAX_FILE).slice(0, 5)])

  const onDrop = (e) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    queueFiles(e.dataTransfer.files)
  }

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

  const startReply = (m) => {
    if (m.deleted || m.kind === 'call' || m.kind === 'sys' || m.kind === 'error') return
    setReplyTo({
      id: m.id,
      name: m.kind === 'self' ? 'You' : (m.name ?? target.name),
      preview: replyPreviewOf(m),
    })
  }

  // every outgoing envelope carries the pending reply reference
  const sendWithReply = (env) => {
    onSend(replyTo ? { ...env, reply: replyTo } : env)
    setReplyTo(null)
  }

  const jumpTo = (msgId) => {
    const el = scrollRef.current?.querySelector(`[data-msg-id="${msgId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1600)
  }

  // WhatsApp swipe/drag-right-to-reply — pointer events cover touch AND mouse.
  // The gesture only arms after 14px of horizontal intent, so clicks, text
  // selection, and vertical scrolling all behave normally.
  const onSwipeStart = (e, m) => {
    if (m.deleted || m.kind === 'call' || m.kind === 'sys' || m.kind === 'error') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    swipe.current = { x: e.clientX, y: e.clientY, dx: 0, el: e.currentTarget, m, live: true, armed: false, pid: e.pointerId }
  }
  const onSwipeMove = (e) => {
    const s = swipe.current
    if (!s?.live) return
    const dx = e.clientX - s.x
    const dy = Math.abs(e.clientY - s.y)
    if (!s.armed) {
      if (dy > 30) { s.live = false; return } // vertical intent: scroll/select
      if (dx < 14) return
      s.armed = true
      s.el.setPointerCapture?.(s.pid)
      document.body.style.userSelect = 'none'
    }
    s.dx = dx
    const pull = Math.min(Math.max(dx, 0), 76)
    s.el.style.transition = 'none'
    s.el.style.transform = `translateX(${pull}px)`
    const badge = s.el.querySelector('.swipe-badge')
    if (badge) {
      badge.style.opacity = Math.min(pull / 60, 1)
      badge.style.transform = `translateY(-50%) scale(${0.6 + Math.min(pull / 60, 1) * 0.4})`
    }
  }
  const onSwipeEnd = () => {
    const s = swipe.current
    if (!s) return
    document.body.style.userSelect = ''
    s.el.style.transition = ''
    s.el.style.transform = ''
    const badge = s.el.querySelector('.swipe-badge')
    if (badge) { badge.style.opacity = 0; badge.style.transform = '' }
    if (s.live && s.armed && s.dx > 56) startReply(s.m)
    swipe.current = null
  }

  const subtitle = target.isGroup
    ? target.members.map((m) => (m.id === clientId ? 'you' : m.name)).join(', ')
    : target.online
      ? convo?.typing
        ? 'typing…'
        : 'online'
      : 'offline'

  return (
    <section
      className="thread"
      onDragEnter={(e) => { e.preventDefault(); if (++dragDepth.current === 1) setDragOver(true) }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false) } }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-inner">
            {Icon.clip}
            Drop to send encrypted
          </div>
        </div>
      )}
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
          <div className="composer-anchor">
            <button
              className="icon-btn"
              aria-label="Options"
              aria-expanded={headMenu}
              onClick={(e) => { e.stopPropagation(); setHeadMenu(!headMenu) }}
            >
              {Icon.dots}
            </button>
            {headMenu && (
              <div className="drawer head-drawer" role="menu" onClick={(e) => e.stopPropagation()}>
                {target.isGroup ? (
                  <>
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
                  </>
                ) : (
                  <button type="button" className="drawer-item danger" role="menuitem" onClick={() => { setHeadMenu(false); if(window.confirm(`Block ${target.name}?`)) onBlock(target.id) }}>
                    <span className="drawer-glyph danger-glyph">{Icon.lock}</span>
                    Block {target.name}
                  </button>
                )}
              </div>
            )}
          </div>
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
              data-msg-id={m.id}
              className={`msg ${m.kind === 'self' ? 'self' : 'peer'} ${grouped ? 'grouped' : ''} ${reactions.length ? 'reacted' : ''}`}
              onContextMenu={(e) => openMenu(e, m)}
              onPointerDown={(e) => onSwipeStart(e, m)}
              onPointerMove={onSwipeMove}
              onPointerUp={onSwipeEnd}
              onPointerCancel={onSwipeEnd}
            >
              <span className="swipe-badge" aria-hidden="true">{Icon.reply}</span>
              <div className={`bubble ${rich ? 'rich' : ''} ${m.body.reply && !m.deleted ? 'has-quote' : ''}`}>
                {m.body.reply && !m.deleted && (
                  <button type="button" className="quote" onClick={() => jumpTo(m.body.reply.id)}>
                    <span className="quote-name">{m.body.reply.name}</span>
                    <span className="quote-text">{m.body.reply.preview}</span>
                  </button>
                )}
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

      {replyTo && (
        <div className="reply-bar">
          <span className="reply-glyph">{Icon.reply}</span>
          <span className="reply-bar-body">
            <span className="quote-name">{replyTo.name}</span>
            <span className="quote-text">{replyTo.preview}</span>
          </span>
          <button className="icon-btn subtle" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>
            {Icon.x}
          </button>
        </div>
      )}
      <Composer target={target} onSend={sendWithReply} onTyping={onTyping} onPickFiles={queueFiles} />

      {pending.length > 0 && (
        <SendPreview
          key={pending[0].name + pending[0].size + pending.length}
          file={pending[0]}
          remaining={pending.length - 1}
          onCancel={() => setPending((q) => q.slice(1))}
          onSend={async (file, caption) => {
            sendWithReply(await fileEnvelope(file, caption))
            setPending((q) => q.slice(1))
          }}
        />
      )}

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onReact={(emoji) => onReact(menu.msg.id, emoji)}
          onReply={() => startReply(menu.msg)}
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
