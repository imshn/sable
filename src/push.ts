const RELAY_BASE = import.meta.env.VITE_RELAY_URL ?? ''

export const pushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window

// VAPID public key comes as a URL-safe base64 string; the Push API wants
// the raw bytes as a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/sw.js')
  return (await reg?.pushManager.getSubscription()) ?? null
}

// Prompts for permission (if needed) and subscribes. Returns the
// subscription, or null if unsupported/denied/no key configured.
export async function subscribeToPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  if (Notification.permission === 'denied') return null

  const reg = await navigator.serviceWorker.register('/sw.js')
  const existing = await reg.pushManager.getSubscription()
  if (existing) return existing

  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') return null

  const { publicKey } = await (await fetch(`${RELAY_BASE}/vapid-key`)).json()
  if (!publicKey) return null

  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  })
}

export async function unsubscribeFromPush(): Promise<PushSubscription | null> {
  const sub = await currentPushSubscription()
  if (sub) await sub.unsubscribe()
  return sub
}

// Real per-notification open tracking: the service worker's notificationclick
// reports back which push got clicked, either via postMessage (an existing
// tab was focused) or, if a fresh window had to be opened, via a ?ackPush=
// query param on first load. Queued here and drained by useChat.ts once the
// socket is actually connected, since either signal can arrive before that.
const pendingAcks: string[] = []

export function queuePushAck(id: string): void {
  if (id) pendingAcks.push(id)
}

export function drainPushAcks(): string[] {
  return pendingAcks.splice(0, pendingAcks.length)
}

// Call once on app start: picks up the fresh-window case above and scrubs
// the query param so a reload doesn't re-report it.
export function consumeAckPushFromUrl(): void {
  const url = new URL(window.location.href)
  const id = url.searchParams.get('ackPush')
  if (!id) return
  queuePushAck(id)
  url.searchParams.delete('ackPush')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
}
