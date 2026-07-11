// Web Push: OS-level notifications that reach a device even with every tab
// closed. Payloads are metadata only ("new message from X") — the server
// still never sees plaintext, so it can't put message content in a push.
import webpush, { type WebPushError } from 'web-push'
import { env } from './config.js'
import { configNumber } from './flags.js'
import type { PushSubscriptionRow, PushPayload } from './types.js'

const PUBLIC_KEY = env.WEB_PUSH_PUBLIC_KEY
const PRIVATE_KEY = env.WEB_PUSH_PRIVATE_KEY
const CONTACT = env.WEB_PUSH_CONTACT

const enabled = !!(PUBLIC_KEY && PRIVATE_KEY)
if (enabled) webpush.setVapidDetails(CONTACT, PUBLIC_KEY!, PRIVATE_KEY!)
else console.log('no WEB_PUSH_PUBLIC_KEY/PRIVATE_KEY — push notifications disabled')

export const vapidPublicKey: string | null = PUBLIC_KEY ?? null

export interface PushResult {
  ok: boolean
  expired?: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Returns { ok } or { ok:false, expired:true } so the caller can prune the
// subscription row when the browser has invalidated it (404/410). Retries
// (operator-configurable count) only on transient failures — an expired
// subscription retrying would just fail the same way every time.
export async function sendPush(sub: PushSubscriptionRow, payload: PushPayload): Promise<PushResult> {
  if (!enabled) return { ok: false }
  const retries = configNumber('push_retry_count', 2)
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      )
      return { ok: true }
    } catch (e) {
      const err = e as WebPushError
      const expired = err.statusCode === 404 || err.statusCode === 410
      if (expired) return { ok: false, expired: true }
      if (attempt === retries) {
        console.error('push send failed', err.statusCode, err.message)
        return { ok: false }
      }
      await sleep(300 * (attempt + 1))
    }
  }
  return { ok: false }
}
