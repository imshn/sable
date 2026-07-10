import { useEffect, useState } from 'react'

// navigator.onLine reflects the device's network interface, not whether our
// relay is actually reachable — that's what useChat's `connected` (socket.io
// connection state) is for. The app combines both: this catches "no network
// at all", the socket state catches "network's up but the server isn't".
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}
