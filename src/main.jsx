import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// ponytail: no StrictMode — double-mounted effects open duplicate sockets in dev
createRoot(document.getElementById('root')).render(<App />)
