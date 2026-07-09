const RELAY_BASE = import.meta.env.VITE_RELAY_URL ?? ''

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window

// VAPID public key comes as a URL-safe base64 string; the Push API wants
// the raw bytes as a Uint8Array.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export async function currentPushSubscription() {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/sw.js')
  return (await reg?.pushManager.getSubscription()) ?? null
}

// Prompts for permission (if needed) and subscribes. Returns the
// subscription, or null if unsupported/denied/no key configured.
export async function subscribeToPush() {
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
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })
}

export async function unsubscribeFromPush() {
  const sub = await currentPushSubscription()
  if (sub) await sub.unsubscribe()
  return sub
}
