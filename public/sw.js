// Push notifications only — this app has no offline/cache strategy, so the
// service worker's only job is turning a push event into an OS notification
// and handling the click. Message content is never in the payload (the
// server can't decrypt it), so there's nothing here to keep private.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* ignore malformed payload */ }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Sable', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus()
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
