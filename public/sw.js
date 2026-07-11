// Push notifications only — this app has no offline/cache strategy, so the
// service worker's only job is turning a push event into an OS notification
// and handling the click. Message content is never in the payload (the
// server can't decrypt it), so there's nothing here to keep private.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* ignore malformed payload */ }

  const ringing = data.kind === 'call-ringing'
  const missed = data.kind === 'call-missed'

  event.waitUntil(
    self.registration.showNotification(data.title || 'Sable', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      // A missed-call push shares its ring's tag so the OS updates that
      // exact notification instead of stacking a second one — renotify
      // makes it buzz again rather than silently swap the text.
      renotify: ringing || missed,
      requireInteraction: ringing,
      vibrate: ringing ? [300, 200, 300, 200, 300] : missed ? [200, 100, 200] : [150],
      data: { url: data.url || '/', pushId: data.pushId },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  const pushId = event.notification.data?.pushId
  const url = event.notification.data?.url || '/'
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if (pushId) c.postMessage({ type: 'push-opened', pushId })
          return c.focus()
        }
      }
      if (clients.openWindow) {
        // No open tab to postMessage — hand the id to the fresh page via the
        // URL instead so it can report the open once its socket connects.
        const target = pushId ? `${url}${url.includes('?') ? '&' : '?'}ackPush=${encodeURIComponent(pushId)}` : url
        return clients.openWindow(target)
      }
    })
  )
})
