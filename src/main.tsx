import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { loadRuntimeConfig } from './runtimeConfig.ts'
import './index.css'

// Registered unconditionally (not gated behind opting into push) so the
// install criteria — manifest + an active service worker — are met even
// for users who never enable notifications.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

loadRuntimeConfig()

// ponytail: no StrictMode — double-mounted effects open duplicate sockets in dev
createRoot(document.getElementById('root')!).render(<App />)
