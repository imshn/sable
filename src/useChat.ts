import { useEffect, useRef, useState, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import {
  loadKeyPair,
  exportPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  fingerprint,
  b64decode,
} from './crypto.ts'
import { currentPushSubscription, subscribeToPush, unsubscribeFromPush } from './push.ts'
import type {
  Contact, Group, Convo, ConvoMessage, MessageBody, OutgoingEnvelope,
  PasskeyActionResult, Passkey, Announcement, MyProfile, EncryptedPayload,
} from './types.ts'

declare global {
  interface Window { __sableSocket?: Socket }
}

// Passwordless identity: your name IS your identity. Entering the same name
// on any device always resolves to the same user — duplicates are impossible
// by construction. Only the newest session for a name stays connected.
export function getClientId(name: string): string {
  return `n-${name.trim().toLowerCase().replace(/\s+/g, '-')}`
}

const emptyConvo = (): Convo => ({ messages: [], unread: 0, typing: null, lastTs: 0 })

// Content envelopes (encrypted as JSON): text / file / loc (+fwd flag)
// Control envelopes: { t: 'react', msgId, emoji|null } and { t: 'delete', msgId }
// Self-copies carry _to so restored sent messages land in the right thread.
// Local-only kinds: 'call' (call logs) and 'sys' (group notices)
const toBody = (env: OutgoingEnvelope): MessageBody => {
  if ('t' in env && env.t === 'file') {
    const url = URL.createObjectURL(new Blob([b64decode(env.data!) as BlobPart], { type: env.mime }))
    return { ...env, data: undefined, url } as MessageBody & { url: string }
  }
  return env as MessageBody
}

interface ContactRow {
  requester_id: string
  recipient_id: string
  recipient_name: string
  requester_name: string
  recipient_username: string
  requester_username: string
  recipient_avatar?: string | null
  requester_avatar?: string | null
  recipient_pubkey: string
  requester_pubkey: string
  status: Contact['status']
  recipient_last_seen?: number | null
  requester_last_seen?: number | null
  online?: boolean
  nickname?: string | null
}

interface BacklogRow {
  id: string
  from: string
  senderPub: string
  groupId?: string
  payload: EncryptedPayload
  ts: number
  fromName?: string
  delivered?: boolean
}

export function useChat(name: string, username: string, activeId: string | null = null) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [convos, setConvos] = useState<Record<string, Convo>>({})
  const [safetyCode, setSafetyCode] = useState('')
  const [connected, setConnected] = useState(false)
  const [sessionReplaced, setSessionReplaced] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [myProfile, setMyProfile] = useState<MyProfile | null>(null)
  const [passkeyRequired, setPasskeyRequired] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)

  const socketRef = useRef<Socket | null>(null)
  const keyCache = useRef(new Map<string, Promise<CryptoKey>>())
  const peerKeyRef = useRef(new Map<string, Promise<CryptoKey>>())
  const selfKeyRef = useRef<Promise<CryptoKey> | null>(null)
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const pubKeyRef = useRef<JsonWebKey | null>(null)
  const deletedAtRef = useRef(new Map<string, number>()) // peerId -> ts; backlog rows at/before this are hidden
  // Use username as the primary identity key if available, otherwise name
  const clientId = getClientId(username || name)

  const patchConvo = (key: string, fn: (c: Convo) => Convo) =>
    setConvos((c) => ({ ...c, [key]: fn(c[key] ?? emptyConvo()) }))

  const updateMessage = (key: string, msgId: string, fn: (m: ConvoMessage) => ConvoMessage) =>
    patchConvo(key, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
    }))

  const addEntry = (key: string, entry: ConvoMessage, bumpUnread: boolean) =>
    patchConvo(key, (c) => ({
      ...c,
      messages: [...c.messages, entry],
      unread: bumpUnread ? c.unread + 1 : c.unread,
      typing: null,
      lastTs: entry.ts,
    }))

  const setTypingFor = (key: string, typerName: string) => {
    patchConvo(key, (c) => ({ ...c, typing: typerName }))
    clearTimeout(typingTimers.current.get(key))
    typingTimers.current.set(
      key,
      setTimeout(() => patchConvo(key, (c) => ({ ...c, typing: null })), 2200)
    )
  }

  const applyControl = (key: string, reactor: string, env: OutgoingEnvelope): boolean => {
    if ('t' in env && env.t === 'react') {
      updateMessage(key, env.msgId, (m) => {
        const reactions = { ...m.reactions }
        if (env.emoji) reactions[reactor] = env.emoji
        else delete reactions[reactor]
        return { ...m, reactions }
      })
      return true
    }
    if ('t' in env && env.t === 'delete') {
      updateMessage(key, env.msgId, (m) => ({ ...m, deleted: true, reactions: {} }))
      return true
    }
    return false
  }

  useEffect(() => {
    let alive = true
    const socket: Socket = import.meta.env.VITE_RELAY_URL ? io(import.meta.env.VITE_RELAY_URL) : io()
    socketRef.current = socket
    if (import.meta.env.DEV) window.__sableSocket = socket // dev-only debugging handle

    // Listeners must attach synchronously: the socket starts connecting the
    // moment io() returns, and events that land while keys load in IndexedDB
    // would otherwise be lost (missed hello, stale presence).
    const ready = (async () => {
      const keyPair = await loadKeyPair()
      const pubKey = await exportPublicKey(keyPair)
      pubKeyRef.current = pubKey
      selfKeyRef.current = deriveSharedKey(keyPair.privateKey, pubKey)
      fingerprint(pubKey).then((code) => alive && setSafetyCode(code))
      const keyFor = (jwk: JsonWebKey) => {
        const id = JSON.stringify(jwk)
        if (!keyCache.current.has(id)) {
          keyCache.current.set(id, deriveSharedKey(keyPair.privateKey, jwk))
        }
        return keyCache.current.get(id)!
      }
      return { pubKey, keyFor }
    })()

    const setup = () => {
      socket.on('connect', async () => {
        const { pubKey } = await ready
        if (!alive) return
        setConnected(true)
        setAuthError(null)
        socket.emit('hello', { id: clientId, name, username, pubKey })

        // re-assert an existing subscription in case the relay's DB doesn't
        // have it anymore (e.g. restarted with a fresh database)
        const existing = await currentPushSubscription()
        if (alive && existing) {
          setPushEnabled(true)
          socket.emit('save-push-subscription', { subscription: existing.toJSON() })
        }
      })
      socket.on('disconnect', () => alive && setConnected(false))

      socket.on('auth-error', (err: string) => {
        if (!alive) return
        setAuthError(err)
        socket.disconnect()
      })

      socket.on('session-replaced', () => {
        if (!alive) return
        socket.disconnect() // don't fight the newer session for the identity
        setSessionReplaced(true)
      })

      socket.on('passkey-required', () => {
        if (!alive) return
        setPasskeyRequired(true)
      })

      socket.on('deleted-conversations', (map: Record<string, number>) => {
        if (!alive) return
        deletedAtRef.current = new Map(Object.entries(map ?? {}).map(([k, v]) => [k, Number(v)]))
      })

      socket.on('passkeys', (rows: Passkey[]) => {
        if (!alive) return
        setPasskeys(rows)
      })

      socket.on('announcement', (a: Announcement) => {
        if (!alive) return
        setAnnouncement(a)
      })

      const parseContacts = (list: ContactRow[]): Contact[] => {
        return list.map(c => {
          const isRequester = c.requester_id === clientId
          const realName = isRequester ? c.recipient_name : c.requester_name
          return {
            id: isRequester ? c.recipient_id : c.requester_id,
            name: c.nickname?.trim() || realName,
            realName,
            nickname: c.nickname ?? null,
            username: isRequester ? c.recipient_username : c.requester_username,
            avatar: isRequester ? c.recipient_avatar : c.requester_avatar,
            pubKey: JSON.parse(isRequester ? c.recipient_pubkey : c.requester_pubkey),
            status: c.status,
            isRequester,
            lastSeen: isRequester ? c.recipient_last_seen : c.requester_last_seen,
            online: c.online || false,
          }
        })
      }

      socket.on('contacts', async (list: ContactRow[]) => {
        const { keyFor } = await ready
        if (!alive) return
        const peers = parseContacts(list)
        for (const peer of peers) peerKeyRef.current.set(peer.id, keyFor(peer.pubKey))
        setContacts(peers)
      })

      socket.on('contact-updated', async (list: ContactRow[]) => {
        const { keyFor } = await ready
        if (!alive) return
        const peers = parseContacts(list)
        // keyFor() already memoizes by the JWK's own content, so this stays
        // cheap when a peer's key hasn't changed — but always refreshing
        // here (like the 'contacts' handler above) matters for when it has
        // (reinstall, cleared storage): a stale peerKeyRef entry would keep
        // encrypting with a shared secret the peer can no longer derive.
        for (const peer of peers) peerKeyRef.current.set(peer.id, keyFor(peer.pubKey))
        setContacts(peers)
      })

      socket.on('presence', ({ id, online, lastSeen }: { id: string; online: boolean; lastSeen: number | null }) => {
        if (!alive) return
        setContacts((prev) => prev.map(c => c.id === id ? { ...c, online, lastSeen } : c))
      })

      // ciphertext history: decrypt and replay in order
      socket.on('backlog', async (rows: BacklogRow[]) => {
        const { keyFor } = await ready
        const restored: Record<string, Convo> = {}
        const convoOf = (key: string) => (restored[key] ??= emptyConvo())
        for (const row of rows) {
          let env: OutgoingEnvelope | null = null
          try {
            const key = row.from === clientId ? await selfKeyRef.current! : await keyFor(JSON.parse(row.senderPub))
            env = JSON.parse(await decrypt(key, row.payload))
          } catch {
            // The embedded sender_pub *should* always match the peer's current
            // key, but if it doesn't for any reason (e.g. a peer's identity was
            // re-created), retry against their current key before giving up —
            // matches the fallback the live 'dm' path gets for free via
            // peerKeyRef, so a message doesn't succeed live and then silently
            // disappear on the next reload.
            if (row.from !== clientId) {
              try {
                const peerKey = await peerKeyRef.current.get(row.from)
                if (peerKey) env = JSON.parse(await decrypt(peerKey, row.payload))
              } catch { /* still undecryptable — fall through to the placeholder below */ }
            }
          }
          const convoKey = row.groupId ?? (row.from === clientId ? (env && '_to' in env ? env._to : undefined) : row.from)
          if (!convoKey) continue
          const deletedAt = deletedAtRef.current.get(convoKey)
          if (deletedAt && row.ts <= deletedAt) continue // hidden by a "delete chat"
          const convo = convoOf(convoKey)
          if (!env) {
            // Never let a message just vanish — show why it's missing, same
            // as the live 'dm' path already does for a failed decrypt.
            convo.messages.push({ id: row.id, kind: 'error', body: { text: `A message from ${row.fromName ?? 'them'} could not be decrypted` }, ts: row.ts })
            convo.lastTs = Math.max(convo.lastTs, row.ts)
            continue
          }
          if ('t' in env && env.t === 'react') {
            const reactor = row.from === clientId ? 'me' : row.from
            convo.messages = convo.messages.map((m) =>
              m.id === env.msgId
                ? { ...m, reactions: env.emoji ? { ...m.reactions, [reactor]: env.emoji } : (() => { const r = { ...m.reactions }; delete r[reactor]; return r })() }
                : m
            )
            continue
          }
          if ('t' in env && env.t === 'delete') {
            convo.messages = convo.messages.map((m) => (m.id === env.msgId ? { ...m, deleted: true, reactions: {} } : m))
            continue
          }
          convo.messages.push({
            id: row.id,
            kind: row.from === clientId ? 'self' : 'peer',
            from: row.from,
            name: row.fromName,
            body: toBody(env),
            ts: row.ts,
            status: row.from === clientId ? (row.delivered ? 'delivered' : 'sent') : undefined,
          })
          convo.lastTs = Math.max(convo.lastTs, row.ts)
        }
        if (!alive) return
        setConvos((current) => {
          // history loads once per connect; live messages that raced ahead win
          const merged: Record<string, Convo> = { ...restored }
          for (const [k, v] of Object.entries(current)) {
            if (!merged[k]) merged[k] = v
            else {
              const seen = new Set(merged[k].messages.map((m) => m.id))
              merged[k] = {
                ...merged[k],
                messages: [...merged[k].messages, ...v.messages.filter((m) => !seen.has(m.id))],
                unread: v.unread,
                lastTs: Math.max(merged[k].lastTs, v.lastTs),
              }
            }
          }
          return merged
        })
      })

      // ----- groups -----
      socket.on('group-added', (g: Group) => {
        if (!alive) return
        setGroups((gs) => [...gs.filter((x) => x.id !== g.id), g])
      })
      socket.on('group-removed', ({ id, by }: { id: string; by?: string }) => {
        if (!alive) return
        setGroups((gs) => gs.filter((x) => x.id !== id))
        if (by) addEntry(id, { id: crypto.randomUUID(), kind: 'sys', body: { text: `Group deleted by ${by}` }, ts: Date.now() }, false)
      })
      socket.on('group-left', ({ id, name: memberName }: { id: string; name: string }) => {
        if (!alive) return
        addEntry(id, { id: crypto.randomUUID(), kind: 'sys', body: { text: `${memberName} left the group` }, ts: Date.now() }, false)
      })
      socket.on('group-joined', ({ id, names }: { id: string; names: string }) => {
        if (!alive) return
        addEntry(id, { id: crypto.randomUUID(), kind: 'sys', body: { text: `${names} joined the group` }, ts: Date.now() }, false)
      })

      // ----- profile -----
      socket.on('profile', (profile: MyProfile) => {
        if (!alive) return
        setMyProfile(profile)
      })

      interface IncomingMessage {
        key: string
        from: string
        fromName?: string
        msgId: string
        payload: EncryptedPayload
        ts: number
        group: boolean
      }

      const onMessage = async ({ key, from, fromName, msgId, payload, ts, group }: IncomingMessage) => {
        const keyPromise = peerKeyRef.current.get(from)
        if (!keyPromise) return
        let env: OutgoingEnvelope | null
        try {
          env = JSON.parse(await decrypt(await keyPromise, payload))
        } catch {
          env = null
        }
        if (!alive) return
        if (env && applyControl(key, from, env)) return
        const entry: ConvoMessage = env
          ? { id: msgId, kind: 'peer', from, name: fromName, body: toBody(env), ts }
          : { id: msgId, kind: 'error', body: { text: `A message from ${fromName} could not be decrypted` }, ts }
        if (!group && env) socket.emit('delivered', { to: from, msgId })
        addEntry(key, entry, true)
      }

      socket.on('dm', ({ from, fromName, id: msgId, payload, ts }: { from: string; fromName?: string; id: string; payload: EncryptedPayload; ts: number }) =>
        onMessage({ key: from, from, fromName, msgId, payload, ts, group: false }))

      socket.on('gdm', ({ groupId, from, fromName, id: msgId, payload, ts }: { groupId: string; from: string; fromName?: string; id: string; payload: EncryptedPayload; ts: number }) =>
        onMessage({ key: groupId, from, fromName, msgId, payload, ts, group: true }))

      socket.on('delivered', ({ from, msgId }: { from: string; msgId: string }) => {
        if (!alive) return
        updateMessage(from, msgId, (m) => ({ ...m, status: 'delivered' }))
      })

      socket.on('typing', ({ from, fromName }: { from: string; fromName: string }) => alive && setTypingFor(from, fromName))
      socket.on('gtyping', ({ groupId, name: typer }: { groupId: string; name: string }) => alive && setTypingFor(groupId, typer))
    }

    setup()

    // socket.io already retries on a backoff timer, but don't make the user
    // wait out that timer once the browser itself says the network is back.
    const onBrowserOnline = () => { if (!socket.connected) socket.connect() }
    window.addEventListener('online', onBrowserOnline)

    return () => {
      alive = false
      typingTimers.current.forEach(clearTimeout)
      window.removeEventListener('online', onBrowserOnline)
      socket.disconnect()
    }
  }, [name]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tells the server which thread (if any) is currently open, so it can
  // still push a notification for a message on some *other* conversation
  // even while this socket is live — re-asserted on reconnect too, since
  // the server's copy of this is only ever in memory.
  useEffect(() => {
    if (connected) socketRef.current?.emit('set-active-thread', { id: activeId })
  }, [activeId, connected])

  const sealWith = async (keyPromise: Promise<CryptoKey> | null | undefined, env: OutgoingEnvelope): Promise<EncryptedPayload | null> => {
    if (!keyPromise) return null
    return encrypt(await keyPromise, JSON.stringify(env))
  }

  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const sendEnvelope = useCallback(async (target: string, env: OutgoingEnvelope, { localEntry = true }: { localEntry?: boolean } = {}) => {
    const socket = socketRef.current
    if (!socket) return
    const msgId = crypto.randomUUID()
    const ts = Date.now()
    const group = groupsRef.current.find((g) => g.id === target)

    if (group) {
      const payloads: Record<string, EncryptedPayload> = {}
      for (const m of group.members) {
        const sealed = await sealWith(
          m.id === clientId ? selfKeyRef.current : peerKeyRef.current.get(m.id),
          env
        )
        if (sealed) payloads[m.id] = sealed
      }
      // mentions ride outside the encryption boundary too (plaintext member
      // ids only, never message text) purely so the server can route a
      // "you were mentioned" push without decrypting anything.
      const mentions = 'mentions' in env && Array.isArray(env.mentions) ? env.mentions.map((m) => m.id) : undefined
      socket.emit('gdm', { groupId: target, id: msgId, payloads, ts, mentions })
    } else {
      const sealed = await sealWith(peerKeyRef.current.get(target), env)
      if (!sealed) return
      const selfPayload = await sealWith(selfKeyRef.current, { ...env, _to: target } as OutgoingEnvelope)
      socket.emit('dm', { to: target, id: msgId, payload: sealed, selfPayload, ts })
    }

    if (localEntry) {
      addEntry(target, { id: msgId, kind: 'self', body: toBody(env), ts, status: 'sent' }, false)
    }
    return msgId
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((target: string, env: OutgoingEnvelope) => sendEnvelope(target, env), [sendEnvelope])

  const react = useCallback((target: string, msgId: string, emoji: string | null) => {
    sendEnvelope(target, { t: 'react', msgId, emoji }, { localEntry: false })
    updateMessage(target, msgId, (m) => {
      const reactions = { ...m.reactions }
      if (emoji) reactions.me = emoji
      else delete reactions.me
      return { ...m, reactions }
    })
  }, [sendEnvelope]) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteForAll = useCallback((target: string, msgId: string) => {
    sendEnvelope(target, { t: 'delete', msgId }, { localEntry: false })
    updateMessage(target, msgId, (m) => ({ ...m, deleted: true, reactions: {} }))
  }, [sendEnvelope]) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteForMe = useCallback((target: string, msgId: string) => {
    patchConvo(target, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== msgId) }))
  }, [])

  const addLocalEntry = useCallback((target: string, body: MessageBody, kind: ConvoMessage['kind'] = 'call') => {
    addEntry(target, { id: crypto.randomUUID(), kind, body, ts: Date.now() }, false)
  }, [])

  const createGroup = useCallback((groupName: string, memberIds: string[], onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('group-create', { name: groupName, members: memberIds }, onDone)
  }, [])

  const deleteGroup = useCallback((groupId: string) => {
    socketRef.current?.emit('group-delete', { groupId })
    setGroups((gs) => gs.filter((g) => g.id !== groupId))
  }, [])

  const leaveGroup = useCallback((groupId: string) => {
    socketRef.current?.emit('group-leave', { groupId })
    setGroups((gs) => gs.filter((g) => g.id !== groupId))
  }, [])

  const inviteToGroup = useCallback((groupId: string, memberIds: string[], onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('group-invite', { groupId, members: memberIds }, onDone)
  }, [])

  const lastTypingSent = useRef(0)
  const notifyTyping = useCallback((target: string) => {
    const now = Date.now()
    if (now - lastTypingSent.current <= 1200) return
    lastTypingSent.current = now
    const isGroup = groupsRef.current.some((g) => g.id === target)
    socketRef.current?.emit(isGroup ? 'gtyping' : 'typing', isGroup ? { groupId: target } : { to: target })
  }, [])

  const markRead = useCallback((target: string) => {
    setConvos((c) => (c[target]?.unread ? { ...c, [target]: { ...c[target], unread: 0 } } : c))
  }, [])

  const sendContactRequest = useCallback((to: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('contact-request', { to }, onDone)
  }, [])

  const acceptContactRequest = useCallback((to: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('contact-accept', { to }, onDone)
  }, [])

  const rejectContactRequest = useCallback((to: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('contact-reject', { to }, onDone)
  }, [])

  const removeContact = useCallback((to: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('contact-remove', { to }, onDone)
  }, [])

  const blockContact = useCallback((to: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('contact-block', { to }, onDone)
  }, [])

  const unblockContact = useCallback((to: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('contact-unblock', { to }, onDone)
  }, [])

  const setContactNickname = useCallback((to: string, nickname: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('set-contact-nickname', { to, nickname }, onDone)
  }, [])

  // Deletes my side of a conversation's history. The peer relationship and
  // any future messages are unaffected — this only clears what's shown.
  const deleteConversation = useCallback((peerId: string) => {
    socketRef.current?.emit('delete-conversation', { peerId })
    deletedAtRef.current.set(peerId, Date.now())
    patchConvo(peerId, () => emptyConvo())
  }, [])

  // Retries login after the server reports this identity has a passkey.
  // Runs the WebAuthn assertion ceremony, then re-authenticates over the
  // same socket; on success the server sends the full session as normal.
  const retryWithPasskey = useCallback(async () => {
    const socket = socketRef.current
    if (!socket) return
    setPasskeyError(null)
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser')
      type LoginOptions = { noPasskey?: boolean; options?: Parameters<typeof startAuthentication>[0]['optionsJSON'] }
      const optionsRes = await new Promise<LoginOptions>((resolve) =>
        socket.emit('webauthn-login-options', { id: clientId }, resolve))
      if (optionsRes?.noPasskey) {
        setPasskeyRequired(false) // stale — proceed as a normal login
        socket.emit('hello', { id: clientId, name, username, pubKey: pubKeyRef.current })
        return
      }
      const response = await startAuthentication({ optionsJSON: optionsRes.options! })
      const verifyRes = await new Promise<PasskeyActionResult>((resolve) =>
        socket.emit('webauthn-login-verify', { id: clientId, name, username, pubKey: pubKeyRef.current, response }, resolve)
      )
      if (verifyRes?.ok) setPasskeyRequired(false)
      else setPasskeyError(verifyRes?.error ?? 'Passkey verification failed')
    } catch (e) {
      // user cancelled the browser prompt, or no authenticator available
      const err = e as { code?: string; message?: string }
      setPasskeyError(err?.code === 'ERROR_CEREMONY_ABORTED' ? 'Cancelled' : err?.message ?? 'Passkey login failed')
    }
  }, [clientId, name, username])

  const enablePush = useCallback(async () => {
    const sub = await subscribeToPush()
    if (!sub) return false
    socketRef.current?.emit('save-push-subscription', { subscription: sub.toJSON() })
    setPushEnabled(true)
    return true
  }, [])

  const disablePush = useCallback(async () => {
    const sub = await unsubscribeFromPush()
    if (sub) socketRef.current?.emit('delete-push-subscription', { endpoint: sub.endpoint })
    setPushEnabled(false)
  }, [])

  const fetchPasskeys = useCallback(() => {
    socketRef.current?.emit('get-passkeys', null, (rows: Passkey[]) => setPasskeys(rows))
  }, [])

  const deletePasskey = useCallback((credentialId: string, onDone?: (ok: boolean) => void) => {
    socketRef.current?.emit('delete-passkey', { credentialId }, onDone)
  }, [])

  // Registers a new passkey for the *currently logged-in* identity. After
  // this succeeds, future logins for this username require it.
  const registerPasskey = useCallback(async (): Promise<PasskeyActionResult> => {
    const socket = socketRef.current
    if (!socket) return { ok: false, error: 'Not connected' }
    try {
      const { startRegistration } = await import('@simplewebauthn/browser')
      type RegisterOptions = { options?: Parameters<typeof startRegistration>[0]['optionsJSON'] }
      const optionsRes = await new Promise<RegisterOptions>((resolve) =>
        socket.emit('webauthn-register-options', null, resolve))
      if (!optionsRes?.options) return { ok: false, error: 'Could not start registration' }
      const response = await startRegistration({ optionsJSON: optionsRes.options })
      const verifyRes = await new Promise<PasskeyActionResult>((resolve) => socket.emit('webauthn-register-verify', { response }, resolve))
      if (verifyRes?.ok) fetchPasskeys()
      return verifyRes ?? { ok: false, error: 'No response' }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      return { ok: false, error: err?.code === 'ERROR_CEREMONY_ABORTED' ? 'Cancelled' : err?.message ?? 'Could not add passkey' }
    }
  }, [fetchPasskeys])

  return {
    clientId, contacts, groups, convos, safetyCode, connected, sessionReplaced, authError, myProfile,
    passkeyRequired, passkeyError, passkeys, pushEnabled, announcement, dismissAnnouncement: () => setAnnouncement(null),
    send, react, deleteForAll, deleteForMe, addLocalEntry, deleteConversation,
    createGroup, deleteGroup, leaveGroup, inviteToGroup,
    sendContactRequest, acceptContactRequest, rejectContactRequest, removeContact, blockContact, unblockContact,
    setContactNickname,
    retryWithPasskey, fetchPasskeys, deletePasskey, registerPasskey, enablePush, disablePush,
    notifyTyping, markRead, socketRef,
  }
}
