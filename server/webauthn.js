// Passkeys: lets a username be locked to a device/authenticator, closing the
// gap where identity is otherwise just "whoever types this name first."
// Optional — a username with no registered passkey logs in exactly as before.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'

const RP_NAME = 'Sable'
// rpID must be a domain the frontend is served from (not the relay's domain —
// WebAuthn ceremonies are verified against the *browser's* origin/page).
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost'
const ORIGINS = (process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim())

export const toB64 = (bytes) => Buffer.from(bytes).toString('base64')
export const fromB64 = (str) => new Uint8Array(Buffer.from(str, 'base64'))

const asCredentialList = (passkeys) =>
  passkeys.map((pk) => ({
    id: pk.credential_id,
    transports: pk.transports ? JSON.parse(pk.transports) : undefined,
  }))

export async function makeRegistrationOptions(username, existingPasskeys) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    attestationType: 'none',
    excludeCredentials: asCredentialList(existingPasskeys),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
}

export async function checkRegistration(response, expectedChallenge) {
  return verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID })
}

export async function makeAuthenticationOptions(passkeys) {
  return generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: asCredentialList(passkeys),
    userVerification: 'preferred',
  })
}

export async function checkAuthentication(response, expectedChallenge, passkeyRow) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    credential: {
      id: passkeyRow.credential_id,
      publicKey: fromB64(passkeyRow.public_key),
      counter: passkeyRow.counter,
      transports: passkeyRow.transports ? JSON.parse(passkeyRow.transports) : undefined,
    },
  })
}
