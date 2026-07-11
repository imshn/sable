import { useEffect, useRef, useState, type RefObject, type FormEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ChangeEvent, type KeyboardEvent } from 'react'
import type { Socket } from 'socket.io-client'
import { Icon } from './icons.tsx'
import { b64encode } from './crypto.ts'
import { ConfirmModal } from './ConfirmModal.tsx'
import { ReportModal } from './ReportModal.tsx'
import { runtimeConfig } from './runtimeConfig.ts'
import { relativeTime } from './relativeTime.ts'
import type { ChatTarget, Convo, ConvoMessage, CallLogBody, FileBody, GroupMember, MentionRef, MessageBody, OutgoingEnvelope, ReplyRef } from './types.ts'

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const initials = (n: string) => n.trim().slice(0, 2).toUpperCase()
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const maxFileBytes = () => runtimeConfig.maxUploadMb * 1024 * 1024

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const callLogText = (body: CallLogBody, peerName: string): string =>
  ({
    ended: `Video call · ${fmtDur(body.dur ?? 0)}`,
    missed: 'Missed video call',
    declined: `${peerName} declined the call`,
    cancelled: 'Video call ended',
    'media-error': 'Could not access camera or microphone',
  })[body.kind] ?? 'Video call'

// short description of a message for reply quotes / the reply bar
export const replyPreviewOf = (m: ConvoMessage): string => {
  if (m.deleted) return 'Message deleted'
  const b = m.body
  if ('t' in b && b.t === 'loc') return 'Location'
  if ('t' in b && b.t === 'file') {
    if (b.caption) return b.caption.slice(0, 120)
    if (b.voice) return 'Voice message'
    if (b.mime?.startsWith('image/')) return 'Photo'
    if (b.mime?.startsWith('video/')) return 'Video'
    if (b.mime?.startsWith('audio/')) return 'Audio'
    return b.name
  }
  return ('text' in b ? b.text : '').slice(0, 120)
}

const isMedia = (m: ConvoMessage): m is ConvoMessage & { body: FileBody } =>
  !m.deleted && 't' in m.body && m.body.t === 'file' && (!!m.body.mime?.startsWith('image/') || !!m.body.mime?.startsWith('video/'))

// file (+ optional caption) -> encrypted-envelope payload
async function fileEnvelope(file: File, caption: string): Promise<FileBody> {
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

interface HistoryFrame {
  w: number
  h: number
  data: ImageData
}

interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

interface SendPreviewProps {
  file: File
  remaining: number
  onSend: (file: File, caption: string) => void
  onCancel: () => void
}

// WhatsApp-style pre-send preview: caption for any file, plus draw / rotate /
// crop / undo for images (canvas pipeline; original bytes kept if untouched).
function SendPreview({ file, remaining, onSend, onCancel }: SendPreviewProps) {
  const isImage = file.type.startsWith('image/')
  const isVideo = file.type.startsWith('video/')
  const [caption, setCaption] = useState('')
  const [tool, setTool] = useState<'draw' | 'crop' | null>(null)
  const [color, setColor] = useState(DRAW_COLORS[0])
  const [canUndo, setCanUndo] = useState(false)
  const [cropReady, setCropReady] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mediaUrl = useRef<string | null>(null)
  const history = useRef<HistoryFrame[]>([])
  const edited = useRef(false)
  const drawing = useRef(false)
  const cropStart = useRef<{ x: number; y: number } | null>(null)
  const cropRect = useRef<CropRect | null>(null)
  const cropBase = useRef<ImageData | null>(null) // ImageData under the marquee preview

  if (!mediaUrl.current) mediaUrl.current = URL.createObjectURL(file)

  useEffect(() => {
    if (!isImage) return
    const img = new Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
    }
    img.src = mediaUrl.current!
    return () => URL.revokeObjectURL(mediaUrl.current!)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const snapshot = () => {
    const c = canvasRef.current!
    history.current.push({ w: c.width, h: c.height, data: c.getContext('2d')!.getImageData(0, 0, c.width, c.height) })
    if (history.current.length > 10) history.current.shift()
    edited.current = true
    setCanUndo(true)
  }

  const undo = () => {
    const prev = history.current.pop()
    if (!prev) return
    const c = canvasRef.current!
    c.width = prev.w
    c.height = prev.h
    c.getContext('2d')!.putImageData(prev.data, 0, 0)
    setCanUndo(history.current.length > 0)
    cancelCrop()
  }

  const rotate = () => {
    snapshot()
    const c = canvasRef.current!
    const tmp = document.createElement('canvas')
    tmp.width = c.height
    tmp.height = c.width
    const t = tmp.getContext('2d')!
    t.translate(tmp.width / 2, tmp.height / 2)
    t.rotate(Math.PI / 2)
    t.drawImage(c, -c.width / 2, -c.height / 2)
    c.width = tmp.width
    c.height = tmp.height
    c.getContext('2d')!.drawImage(tmp, 0, 0)
    cancelCrop()
  }

  const canvasPoint = (e: ReactPointerEvent) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(c.width, (e.clientX - r.left) * (c.width / r.width))),
      y: Math.max(0, Math.min(c.height, (e.clientY - r.top) * (c.height / r.height))),
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!tool) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = canvasPoint(e)
    const ctx = canvasRef.current!.getContext('2d')!
    if (tool === 'draw') {
      snapshot()
      drawing.current = true
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(4, canvasRef.current!.width / 160)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
    } else if (tool === 'crop') {
      const c = canvasRef.current!
      if (!cropBase.current) cropBase.current = ctx.getImageData(0, 0, c.width, c.height)
      cropStart.current = p
      cropRect.current = null
      setCropReady(false)
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!tool) return
    const p = canvasPoint(e)
    const c = canvasRef.current!
    const ctx = c.getContext('2d')!
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
      ctx.putImageData(cropBase.current!, 0, 0)
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, c.width, c.height)
      // restore the selected region at full brightness
      ctx.putImageData(cropBase.current!, 0, 0, rect.x, rect.y, rect.w, rect.h)
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
        c.getContext('2d')!.putImageData(cropBase.current, 0, 0)
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
    const c = canvasRef.current!
    c.getContext('2d')!.putImageData(base, 0, 0) // clean image, no marquee
    const tmp = document.createElement('canvas')
    tmp.width = rect.w
    tmp.height = rect.h
    tmp.getContext('2d')!.drawImage(c, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    c.width = rect.w
    c.height = rect.h
    c.getContext('2d')!.drawImage(tmp, 0, 0)
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
      const blob = await new Promise<Blob | null>((res) => canvasRef.current!.toBlob(res, type, 0.92))
      if (blob) out = new File([blob], file.name.replace(/\.\w+$/, type === 'image/png' ? '.png' : '.jpg'), { type })
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

// URLs become safe anchors; @mentions (when the message carries a mentions
// list) become highlighted tags. Both share one pass so ranges never overlap.
const URL_RE = /(https?:\/\/[^\s<>"']+)/g
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function Linkified({ text, mentions }: { text: string; mentions?: MentionRef[] }) {
  const names = mentions?.length
    ? [...new Set(mentions.map((m) => m.name))].sort((a, b) => b.length - a.length).map(escapeRe)
    : []
  const re = names.length
    ? new RegExp(`(https?://[^\\s<>"']+)|(@(?:${names.join('|')})\\b)`, 'g')
    : new RegExp(URL_RE.source, 'g')

  const nodes: (string | React.ReactElement)[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(
      m[0].startsWith('@') ? (
        <span key={key++} className="mention-tag">{m[0]}</span>
      ) : (
        <a key={key++} href={m[0]} target="_blank" rel="noopener noreferrer" className="msg-link">{m[0]}</a>
      )
    )
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// OG-card preview for the first link in a message, WhatsApp style.
// The relay's /preview endpoint does the fetch (CORS blocks doing it here).
const RELAY_BASE = import.meta.env.VITE_RELAY_URL ?? ''
interface PreviewData {
  title?: string
  description?: string
  image?: string
  site?: string
}
const previewCache = new Map<string, PreviewData>()

function LinkPreview({ url }: { url: string }) {
  const [data, setData] = useState<PreviewData | undefined>(previewCache.get(url))

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
      {data.image && <img src={data.image} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />}
      <span className="lp-body">
        {data.title && <span className="lp-title">{data.title}</span>}
        {data.description && <span className="lp-desc">{data.description}</span>}
        <span className="lp-domain">{new URL(url).hostname}</span>
      </span>
    </a>
  )
}

function MessageBodyView({ body, onOpenMedia }: { body: MessageBody; onOpenMedia: () => void }) {
  if ('t' in body && body.t === 'loc') {
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
  if ('t' in body && body.t === 'file') {
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
  const text = 'text' in body ? body.text : ''
  const mentions = 'mentions' in body ? body.mentions : undefined
  const firstUrl = text.match(URL_RE)?.[0]
  if (!firstUrl) return <Linkified text={text} mentions={mentions} />
  return (
    <span className="text-with-preview">
      <LinkPreview url={firstUrl} />
      <span><Linkified text={text} mentions={mentions} /></span>
    </span>
  )
}

interface MenuState {
  msg: ConvoMessage
  x: number
  y: number
}

interface ContextMenuProps {
  menu: MenuState
  onClose: () => void
  onReact: (emoji: string | null) => void
  onReply: () => void
  onCopy: () => void
  onForward: () => void
  onDeleteMe: () => void
  onDeleteAll: () => void
}

function ContextMenu({ menu, onClose, onReact, onReply, onCopy, onForward, onDeleteMe, onDeleteAll }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
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
      {'t' in msg.body && msg.body.t === 'text' && (
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

function Lightbox({ items, index, onClose, onNav }: { items: (ConvoMessage & { body: FileBody })[]; index: number; onClose: () => void; onNav: (delta: number) => void }) {
  const item = items[index]

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
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

interface LatLng {
  lat: number
  lng: number
}

function LocationModal({ onSend, onClose }: { onSend: (pos: LatLng) => void; onClose: () => void }) {
  const [pos, setPos] = useState<LatLng | null>(null)
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
        <button className="primary" disabled={!pos} onClick={() => { onSend(pos!); onClose() }}>
          Send this location
          <span className="btn-icon">{Icon.pin}</span>
        </button>
      </div>
    </div>
  )
}

type ComposerMenu = 'attach' | 'location' | null

interface ComposerProps {
  target: ChatTarget
  onSend: (env: OutgoingEnvelope) => void
  onTyping: () => void
  onPickFiles: (files: FileList | File[]) => void
}

function Composer({ target, onSend, onTyping, onPickFiles }: ComposerProps) {
  const [draft, setDraft] = useState('')
  const [rec, setRec] = useState<(MediaRecorder & { cancelled?: boolean }) | null>(null)
  const [recElapsed, setRecElapsed] = useState(0)
  const [note, setNote] = useState('')
  const [menu, setMenu] = useState<ComposerMenu>(null)
  const [locModal, setLocModal] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null) // null = dropdown closed
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map()) // id -> name, for this draft
  // three static inputs with fixed accepts — mutating one input's accept right
  // before .click() is flaky in Safari, so each category gets its own element
  const photosRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLInputElement>(null)
  const docsRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const mentionStart = useRef(0)

  useEffect(() => {
    setDraft('')
    setNote('')
    setMenu(null)
    setMentionQuery(null)
    setMentioned(new Map())
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

  const flash = (text: string) => {
    setNote(text)
    setTimeout(() => setNote(''), 3000)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    // only keep mentions whose @name is still actually in the text — covers
    // the user deleting an inserted mention by hand afterward
    const mentions = target.isGroup
      ? [...mentioned].filter(([, name]) => text.includes(`@${name}`)).map(([id, name]) => ({ id, name }))
      : []
    onSend({ t: 'text', text, ...(mentions.length ? { mentions } : {}) })
    setDraft('')
    setMentioned(new Map())
  }

  // @mentions: only relevant in groups. Detects an "@" that starts a word
  // (start of message or after whitespace) with no space typed since.
  const onDraftChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    const cursor = e.target.selectionStart ?? value.length
    setDraft(value)
    onTyping()
    if (!target.isGroup) return
    const uptoCursor = value.slice(0, cursor)
    const atIndex = uptoCursor.lastIndexOf('@')
    const charBefore = atIndex > 0 ? uptoCursor[atIndex - 1] : ''
    if (atIndex === -1 || /\s/.test(uptoCursor.slice(atIndex + 1)) || (charBefore && !/\s/.test(charBefore))) {
      setMentionQuery(null)
      return
    }
    mentionStart.current = atIndex
    setMentionQuery(uptoCursor.slice(atIndex + 1))
  }

  const pickMention = (member: GroupMember) => {
    const before = draft.slice(0, mentionStart.current)
    const after = draft.slice(mentionStart.current + 1 + (mentionQuery?.length ?? 0))
    const insertion = `@${member.name} `
    setDraft(before + insertion + after)
    setMentioned((prev) => new Map(prev).set(member.id, member.name))
    setMentionQuery(null)
    requestAnimationFrame(() => {
      const pos = before.length + insertion.length
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  const mentionCandidates =
    mentionQuery !== null
      ? (target.members ?? [])
          .filter((m) => m.name.toLowerCase().includes(mentionQuery.toLowerCase()))
          .slice(0, 6)
      : []

  const sendFiles = (files: FileList | File[]) => {
    const ok = [...files].slice(0, 5).filter((f) => {
      if (f.size > maxFileBytes()) {
        flash(`${f.name} is over ${runtimeConfig.maxUploadMb} MB`)
        return false
      }
      return true
    })
    if (ok.length) onPickFiles(ok)
  }

  const startVoice = async () => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      flash('Microphone unavailable')
      return
    }
    const recorder: MediaRecorder & { cancelled?: boolean } = new MediaRecorder(new MediaStream(stream.getAudioTracks()))
    const chunks: Blob[] = []
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

  const stopVoice = (cancelled: boolean) => {
    if (!rec) return
    rec.cancelled = cancelled
    rec.stop()
    setRec(null)
  }

  const fileInput = (ref: RefObject<HTMLInputElement | null>, accept: string) => (
    <input
      ref={ref}
      type="file"
      accept={accept || undefined}
      multiple
      style={{ display: 'none' }}
      onChange={(e) => { if (e.target.files) sendFiles(e.target.files); e.target.value = '' }}
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
                if (!navigator.geolocation) { flash('Location is not available here'); return }
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

      <div className="composer-anchor" style={{ flex: 1 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={onDraftChange}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') setMentionQuery(null) }}
          placeholder={target.online || target.isGroup ? 'Write privately…' : `${target.name} is offline — they'll get it when back`}
          aria-label="Message"
          autoComplete="off"
        />
        {mentionQuery !== null && mentionCandidates.length > 0 && (
          <div className="drawer mention-drawer" role="menu">
            {mentionCandidates.map((m) => (
              <button
                key={m.id}
                type="button"
                className="drawer-item"
                role="menuitem"
                onClick={() => pickMention(m)}
              >
                <span className="avatar small-avatar" aria-hidden="true">{m.name.slice(0, 2).toUpperCase()}</span>
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>
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

interface SwipeState {
  x: number
  y: number
  dx: number
  el: HTMLElement
  m: ConvoMessage
  live: boolean
  armed: boolean
  pid: number
}

interface ThreadProps {
  target: ChatTarget
  convo?: Convo
  clientId: string
  onBack: () => void
  onSend: (env: OutgoingEnvelope) => void
  onTyping: () => void
  onStartCall: () => void
  callBusy: boolean
  onReact: (msgId: string, emoji: string | null) => void
  onDeleteMe: (msgId: string) => void
  onDeleteAll: (msgId: string) => void
  onForward: (msg: ConvoMessage) => void
  onLeaveGroup: () => void
  onDeleteGroup: () => void
  onAddMembers: () => void
  onBlock: (id: string) => void
  onUnblock?: (id: string) => void
  onDeleteConversation?: (id: string) => void
  socketRef?: RefObject<Socket | null>
}

// target: { id, name, online, isGroup, members?, owner?, mine? }
export function Thread({
  target, convo, clientId, onBack, onSend, onTyping, onStartCall, callBusy,
  onReact, onDeleteMe, onDeleteAll, onForward, onLeaveGroup, onDeleteGroup, onAddMembers, onBlock, onUnblock,
  onDeleteConversation, socketRef,
}: ThreadProps) {
  const scrollRef = useRef<HTMLElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [headMenu, setHeadMenu] = useState(false)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [pending, setPending] = useState<File[]>([]) // files awaiting caption/edit before send
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null)
  const [blockModal, setBlockModal] = useState(false)
  const [reportModal, setReportModal] = useState(false)
  const [deleteChatModal, setDeleteChatModal] = useState(false)
  const swipe = useRef<SwipeState | null>(null)
  const dragDepth = useRef(0)
  const messages = convo?.messages ?? []
  const mediaList = messages.filter(isMedia)

  const queueFiles = (files: FileList | File[]) =>
    setPending((q) => [...q, ...[...files].filter((f) => f.size <= maxFileBytes()).slice(0, 5)])

  const onDrop = (e: React.DragEvent) => {
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

  const openMenu = (e: MouseEvent, m: ConvoMessage) => {
    if (m.deleted || m.kind === 'call' || m.kind === 'sys' || m.kind === 'error') return
    e.preventDefault()
    setMenu({ msg: m, x: e.clientX, y: e.clientY })
  }

  const startReply = (m: ConvoMessage) => {
    if (m.deleted || m.kind === 'call' || m.kind === 'sys' || m.kind === 'error') return
    setReplyTo({
      id: m.id,
      name: m.kind === 'self' ? 'You' : (m.name ?? target.name),
      preview: replyPreviewOf(m),
    })
  }

  // every outgoing envelope carries the pending reply reference
  const sendWithReply = (env: OutgoingEnvelope) => {
    onSend(replyTo ? { ...env, reply: replyTo } as OutgoingEnvelope : env)
    setReplyTo(null)
  }

  const jumpTo = (msgId: string) => {
    const el = scrollRef.current?.querySelector(`[data-msg-id="${msgId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1600)
  }

  // WhatsApp swipe/drag-right-to-reply — pointer events cover touch AND mouse.
  // The gesture only arms after 14px of horizontal intent, so clicks, text
  // selection, and vertical scrolling all behave normally.
  const onSwipeStart = (e: ReactPointerEvent, m: ConvoMessage) => {
    if (m.deleted || m.kind === 'call' || m.kind === 'sys' || m.kind === 'error') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    swipe.current = { x: e.clientX, y: e.clientY, dx: 0, el: e.currentTarget as HTMLElement, m, live: true, armed: false, pid: e.pointerId }
  }
  const onSwipeMove = (e: ReactPointerEvent) => {
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
    const badge = s.el.querySelector('.swipe-badge') as HTMLElement | null
    if (badge) {
      badge.style.opacity = String(Math.min(pull / 60, 1))
      badge.style.transform = `translateY(-50%) scale(${0.6 + Math.min(pull / 60, 1) * 0.4})`
    }
  }
  const onSwipeEnd = () => {
    const s = swipe.current
    if (!s) return
    document.body.style.userSelect = ''
    s.el.style.transition = ''
    s.el.style.transform = ''
    const badge = s.el.querySelector('.swipe-badge') as HTMLElement | null
    if (badge) { badge.style.opacity = '0'; badge.style.transform = '' }
    if (s.live && s.armed && s.dx > 56) startReply(s.m)
    swipe.current = null
  }

  const subtitle = target.isGroup
    ? (target.members ?? []).map((m) => (m.id === clientId ? 'you' : m.name)).join(', ')
    : target.online
      ? convo?.typing
        ? 'typing…'
        : 'online'
      : target.lastSeen
        ? `last seen ${relativeTime(target.lastSeen)}`
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
            disabled={!target.online || callBusy || (target.status === 'blocked' && target.isRequester)}
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
                  <>
                    <button type="button" className="drawer-item" role="menuitem" onClick={() => { setHeadMenu(false); setDeleteChatModal(true) }}>
                      <span className="drawer-glyph">{Icon.trash}</span>
                      Delete chat
                    </button>
                    {target.status === 'blocked' && target.isRequester ? (
                      <button type="button" className="drawer-item" role="menuitem" onClick={() => { setHeadMenu(false); onUnblock?.(target.id) }}>
                        <span className="drawer-glyph">{Icon.check}</span>
                        Unblock {target.name}
                      </button>
                    ) : (
                      <>
                        <button type="button" className="drawer-item danger" role="menuitem" onClick={() => { setHeadMenu(false); setBlockModal(true) }}>
                          <span className="drawer-glyph danger-glyph">{Icon.block}</span>
                          Block {target.name}
                        </button>
                        <button type="button" className="drawer-item danger" role="menuitem" onClick={() => { setHeadMenu(false); setReportModal(true) }}>
                          <span className="drawer-glyph danger-glyph">{Icon.flag}</span>
                          Report {target.name}
                        </button>
                      </>
                    )}
                  </>
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
            return <div key={m.id} className="sys-line">{'text' in m.body ? m.body.text : ''}</div>
          }
          if (m.kind === 'call') {
            const callBody = m.body as CallLogBody
            return (
              <div key={m.id} className={`call-log ${callBody.kind === 'missed' ? 'missed' : ''}`}>
                {callBody.kind === 'missed' || callBody.kind === 'declined' ? Icon.videoOff : Icon.video}
                {callLogText(callBody, target.name)}
                <time>{timeFmt.format(m.ts)}</time>
              </div>
            )
          }
          const prev = messages[i - 1]
          const grouped = !!(prev && prev.kind === m.kind && prev.from === m.from && m.ts - prev.ts < 120000)
          const rich = (!('t' in m.body) || m.body.t !== 'text') && !m.deleted
          const reactions = Object.values(m.reactions ?? {})
          const reply = 'reply' in m.body ? m.body.reply : undefined
          const fwd = 'fwd' in m.body ? m.body.fwd : undefined
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
              <div className={`bubble ${rich ? 'rich' : ''} ${reply && !m.deleted ? 'has-quote' : ''}`}>
                {reply && !m.deleted && (
                  <button type="button" className="quote" onClick={() => jumpTo(reply.id)}>
                    <span className="quote-name">{reply.name}</span>
                    <span className="quote-text">{reply.preview}</span>
                  </button>
                )}
                {target.isGroup && m.kind === 'peer' && !grouped && (
                  <span className="sender-name">{m.name}</span>
                )}
                {fwd && !m.deleted && <span className="fwd-tag">{Icon.forward} forwarded</span>}
                {m.deleted ? (
                  <em className="decrypt-error">This message was deleted</em>
                ) : m.kind === 'error' ? (
                  <em className="decrypt-error">{'text' in m.body ? m.body.text : ''}</em>
                ) : (
                  <MessageBodyView
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
      {target.status === 'blocked' && target.isRequester ? (
        <div style={{ padding: '24px', textAlign: 'center', backgroundColor: 'var(--surface-2)', borderTop: '1px solid var(--border)' }}>
          <p style={{ margin: '0 0 16px 0', color: 'var(--muted)' }}>You blocked this contact. You can't send messages or call them.</p>
          <button type="button" className="secondary" onClick={() => onUnblock?.(target.id)}>Unblock</button>
        </div>
      ) : (
        <Composer target={target} onSend={sendWithReply} onTyping={onTyping} onPickFiles={queueFiles} />
      )}

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
          onCopy={() => navigator.clipboard?.writeText('text' in menu.msg.body ? menu.msg.body.text ?? '' : '')}
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
          onNav={(delta) => setLightbox((i) => Math.max(0, Math.min(mediaList.length - 1, (i ?? 0) + delta)))}
        />
      )}
      {blockModal && (
        <ConfirmModal
          title="Block User"
          message={`Are you sure you want to block ${target.name}?`}
          confirmText="Block"
          danger={true}
          onConfirm={() => { onBlock(target.id); setBlockModal(false) }}
          onCancel={() => setBlockModal(false)}
        />
      )}
      {reportModal && (
        <ReportModal
          targetName={target.name}
          targetId={target.id}
          socket={socketRef?.current}
          onClose={() => setReportModal(false)}
        />
      )}
      {deleteChatModal && (
        <ConfirmModal
          title="Delete chat"
          message={`Delete your history with ${target.name}? This only clears it on your side — they'll keep their copy, and new messages still come through.`}
          confirmText="Delete"
          danger={true}
          onConfirm={() => { onDeleteConversation?.(target.id); setDeleteChatModal(false) }}
          onCancel={() => setDeleteChatModal(false)}
        />
      )}
    </section>
  )
}
