// Web Push: OS-level notifications that reach a device even with every tab
// closed. Payloads are metadata only ("new message from X") — the server
// still never sees plaintext, so it can't put message content in a push.
import webpush from 'web-push'

const PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY
const PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY
const CONTACT = process.env.WEB_PUSH_CONTACT || 'mailto:admin@example.com'

const enabled = !!(PUBLIC_KEY && PRIVATE_KEY)
if (enabled) webpush.setVapidDetails(CONTACT, PUBLIC_KEY, PRIVATE_KEY)
else console.log('no WEB_PUSH_PUBLIC_KEY/PRIVATE_KEY — push notifications disabled')

export const vapidPublicKey = PUBLIC_KEY ?? null

// Returns { ok } or { ok:false, expired:true } so the caller can prune the
// subscription row when the browser has invalidated it (404/410).
export async function sendPush(sub, payload) {
  if (!enabled) return { ok: false }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    )
    return { ok: true }
  } catch (e) {
    const expired = e.statusCode === 404 || e.statusCode === 410
    if (!expired) console.error('push send failed', e.statusCode, e.message)
    return { ok: false, expired }
  }
}
