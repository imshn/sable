// End-to-end encryption via Web Crypto: ECDH P-256 key agreement,
// AES-256-GCM per message. Private keys are non-extractable and never leave the browser.

// Chunked base64 — String.fromCharCode(...bigArray) blows the stack on large files.
export function b64encode(buf) {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(out)
}

export function b64decode(str) {
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
}

export async function exportPublicKey(keyPair) {
  return crypto.subtle.exportKey('jwk', keyPair.publicKey)
}

export async function deriveSharedKey(privateKey, peerJwk) {
  const peerKey = await crypto.subtle.importKey(
    'jwk',
    peerJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))
  return { iv: b64encode(iv), ct: b64encode(ct) }
}

export async function decrypt(key, { iv, ct }) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(iv) }, key, b64decode(ct))
  return new TextDecoder().decode(pt)
}

// Short safety code from a public key, for out-of-band verification.
export async function fingerprint(jwk) {
  const data = new TextEncoder().encode(jwk.x + jwk.y)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 12).match(/.{4}/g).join(' ')
}
