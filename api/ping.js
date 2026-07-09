// Vercel cron target: pings the relay so it stays warm.
// Hobby crons fire once a day; the every-10-min GitHub Action does the real
// keepalive — this is the belt to its suspenders.
export default async function handler(req, res) {
  const relay = process.env.VITE_RELAY_URL
  if (!relay) return res.status(200).json({ ok: false, reason: 'no relay configured' })
  try {
    const r = await fetch(`${relay}/healthz`, { signal: AbortSignal.timeout(8000) })
    const body = await r.json()
    res.status(200).json({ ok: true, relay: body })
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e) })
  }
}
