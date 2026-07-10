// Process-wide in-memory presence state — one relay instance, one set of
// live maps. Split out of index.js's module scope so every socket-handler
// module can share the same instances instead of threading them through
// every function call.
import type { OnlineUser, KnownUser, GroupState } from './types.js'
import type { PrivacySettingsRow } from './types.js'

export const online = new Map<string, OnlineUser>()   // clientId -> presence
export const known = new Map<string, KnownUser>()      // clientId -> last-known identity
export const groups = new Map<string, GroupState>()    // groupId  -> roster

// Privacy settings cache to avoid hitting DB on every message
export const privacyCache = new Map<string, PrivacySettingsRow>()

// WebAuthn ceremony challenges: identity -> { challenge, at }. Short-lived
// (5 min) and single-flight per identity; see freshChallenge() in sockets/settings.ts.
export const webauthnChallenges = new Map<string, { challenge: string; at: number }>()
