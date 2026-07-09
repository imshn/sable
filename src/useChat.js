import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'
import {
  loadKeyPair,
  exportPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  fingerprint,
  b64decode,
} from './crypto.js'

// Passwordless identity: your name IS your identity. Entering the same name
// on any device always resolves to the same user — duplicates are impossible
// by construction. Only the newest session for a name stays connected.
export function getClientId(name) {
  return `n-${name.trim().toLowerCase().replace(/\s+/g, '-')}`
}

const emptyConvo = () => ({ messages: [], unread: 0, typing: null, lastTs: 0 })

// Content envelopes (encrypted as JSON): text / file / loc (+fwd flag)
// Control envelopes: { t: 'react', msgId, emoji|null } and { t: 'delete', msgId }
// Self-copies carry _to so restored sent messages land in the right thread.
// Local-only kinds: 'call' (call logs) and 'sys' (group notices)
const toBody = (env) => {
  if (env.t === 'file') {
    const url = URL.createObjectURL(new Blob([b64decode(env.data)], { type: env.mime }))
    return { ...env, data: undefined, url }
  }
  return env
}

export function useChat(name, username) {
  const [contacts, setContacts] = useState([]) // [{ id, name, username, avatar, online, lastSeen, status, isRequester }]
  const [groups, setGroups] = useState([])
  const [convos, setConvos] = useState({})
  const [safetyCode, setSafetyCode] = useState('')
  const [connected, setConnected] = useState(false)
  const [sessionReplaced, setSessionReplaced] = useState(false)
  const [authError, setAuthError] = useState(null)

  const socketRef = useRef(null)
  const keyCache = useRef(new Map()) // JSON(jwk) -> Promise<CryptoKey>
  const peerKeyRef = useRef(new Map()) // peerId -> Promise<CryptoKey> (their latest key)
  const selfKeyRef = useRef(null) // Promise<CryptoKey> for own history copies
  const typingTimers = useRef(new Map())
  // Use username as the primary identity key if available, otherwise name
  const clientId = getClientId(username || name)

  const patchConvo = (key, fn) =>
    setConvos((c) => ({ ...c, [key]: fn(c[key] ?? emptyConvo()) }))

  const updateMessage = (key, msgId, fn) =>
    patchConvo(key, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
    }))

  const addEntry = (key, entry, bumpUnread) =>
    patchConvo(key, (c) => ({
      ...c,
      messages: [...c.messages, entry],
      unread: bumpUnread ? c.unread + 1 : c.unread,
      typing: null,
      lastTs: entry.ts,
    }))

  const setTypingFor = (key, typerName) => {
    patchConvo(key, (c) => ({ ...c, typing: typerName }))
    clearTimeout(typingTimers.current.get(key))
    typingTimers.current.set(
      key,
      setTimeout(() => patchConvo(key, (c) => ({ ...c, typing: null })), 2200)
    )
  }

  const applyControl = (key, reactor, env) => {
    if (env?.t === 'react') {
      updateMessage(key, env.msgId, (m) => {
        const reactions = { ...m.reactions }
        if (env.emoji) reactions[reactor] = env.emoji
        else delete reactions[reactor]
        return { ...m, reactions }
      })
      return true
    }
    if (env?.t === 'delete') {
      updateMessage(key, env.msgId, (m) => ({ ...m, deleted: true, reactions: {} }))
      return true
    }
    return false
  }

  useEffect(() => {
    let alive = true
    const socket = import.meta.env.VITE_RELAY_URL ? io(import.meta.env.VITE_RELAY_URL) : io()
    socketRef.current = socket
    if (import.meta.env.DEV) window.__sableSocket = socket // dev-only debugging handle

    // Listeners must attach synchronously: the socket starts connecting the
    // moment io() returns, and events that land while keys load in IndexedDB
    // would otherwise be lost (missed hello, stale presence).
    const ready = (async () => {
      const keyPair = await loadKeyPair()
      const pubKey = await exportPublicKey(keyPair)
      selfKeyRef.current = deriveSharedKey(keyPair.privateKey, pubKey)
      fingerprint(pubKey).then((code) => alive && setSafetyCode(code))
      const keyFor = (jwk) => {
        const id = JSON.stringify(jwk)
        if (!keyCache.current.has(id)) {
          keyCache.current.set(id, deriveSharedKey(keyPair.privateKey, jwk))
        }
        return keyCache.current.get(id)
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
      })
      socket.on('disconnect', () => alive && setConnected(false))

      socket.on('auth-error', (err) => {
        if (!alive) return
        setAuthError(err)
        socket.disconnect()
      })

      socket.on('session-replaced', () => {
        if (!alive) return
        socket.disconnect() // don't fight the newer session for the identity
        setSessionReplaced(true)
      })

      const parseContacts = (list) => {
        return list.map(c => {
          const isRequester = c.requester_id === clientId;
          return {
            id: isRequester ? c.recipient_id : c.requester_id,
            name: isRequester ? c.recipient_name : c.requester_name,
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

      socket.on('contacts', async (list) => {
        const { keyFor } = await ready
        if (!alive) return
        const peers = parseContacts(list)
        for (const peer of peers) peerKeyRef.current.set(peer.id, keyFor(peer.pubKey))
        setContacts(peers)
      })

      socket.on('contact-updated', async (list) => {
        const { keyFor } = await ready
        if (!alive) return
        const peers = parseContacts(list)
        for (const peer of peers) {
          if (!peerKeyRef.current.has(peer.id)) {
            peerKeyRef.current.set(peer.id, keyFor(peer.pubKey))
          }
        }
        setContacts(peers)
      })

      socket.on('presence', ({ id, online, lastSeen }) => {
        if (!alive) return
        setContacts((prev) => prev.map(c => c.id === id ? { ...c, online, lastSeen } : c))
      })

      // ciphertext history: decrypt and replay in order
      socket.on('backlog', async (rows) => {
        const { keyFor } = await ready
        const restored = {} // convoKey -> convo
        const convoOf = (key) => (restored[key] ??= emptyConvo())
        for (const row of rows) {
          let env
          try {
            const key = row.from === clientId ? await selfKeyRef.current : await keyFor(row.senderPub)
            env = JSON.parse(await decrypt(key, row.payload))
          } catch {
            continue // rotated keys or corrupt row — skip silently
          }
          const convoKey = row.groupId ?? (row.from === clientId ? env._to : row.from)
          if (!convoKey) continue
          const convo = convoOf(convoKey)
          if (env.t === 'react') {
            const reactor = row.from === clientId ? 'me' : row.from
            convo.messages = convo.messages.map((m) =>
              m.id === env.msgId
                ? { ...m, reactions: env.emoji ? { ...m.reactions, [reactor]: env.emoji } : (() => { const r = { ...m.reactions }; delete r[reactor]; return r })() }
                : m
            )
            continue
          }
          if (env.t === 'delete') {
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
            status: row.from === clientId ? 'sent' : undefined,
          })
          convo.lastTs = Math.max(convo.lastTs, row.ts)
        }
        if (!alive) return
        setConvos((current) => {
          // history loads once per connect; live messages that raced ahead win
          const merged = { ...restored }
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
      socket.on('group-added', (g) => {
        if (!alive) return
        setGroups((gs) => [...gs.filter((x) => x.id !== g.id), g])
      })
      socket.on('group-removed', ({ id, by }) => {
        if (!alive) return
        setGroups((gs) => gs.filter((x) => x.id !== id))
        if (by) addEntry(id, { id: crypto.randomUUID(), kind: 'sys', body: { text: `Group deleted by ${by}` }, ts: Date.now() }, false)
      })
      socket.on('group-left', ({ id, name: memberName }) => {
        if (!alive) return
        addEntry(id, { id: crypto.randomUUID(), kind: 'sys', body: { text: `${memberName} left the group` }, ts: Date.now() }, false)
      })
      socket.on('group-joined', ({ id, names }) => {
        if (!alive) return
        addEntry(id, { id: crypto.randomUUID(), kind: 'sys', body: { text: `${names} joined the group` }, ts: Date.now() }, false)
      })

      const onMessage = async ({ key, from, fromName, msgId, payload, ts, group }) => {
        const keyPromise = peerKeyRef.current.get(from)
        if (!keyPromise) return
        let env
        try {
          env = JSON.parse(await decrypt(await keyPromise, payload))
        } catch {
          env = null
        }
        if (!alive) return
        if (env && applyControl(key, from, env)) return
        const entry = env
          ? { id: msgId, kind: 'peer', from, name: fromName, body: toBody(env), ts }
          : { id: msgId, kind: 'error', body: { t: 'text', text: `A message from ${fromName} could not be decrypted` }, ts }
        if (!group && env) socket.emit('delivered', { to: from, msgId })
        addEntry(key, entry, true)
      }

      socket.on('dm', ({ from, fromName, id: msgId, payload, ts }) =>
        onMessage({ key: from, from, fromName, msgId, payload, ts, group: false }))

      socket.on('gdm', ({ groupId, from, fromName, id: msgId, payload, ts }) =>
        onMessage({ key: groupId, from, fromName, msgId, payload, ts, group: true }))

      socket.on('delivered', ({ from, msgId }) => {
        if (!alive) return
        updateMessage(from, msgId, (m) => ({ ...m, status: 'delivered' }))
      })

      socket.on('typing', ({ from, fromName }) => alive && setTypingFor(from, fromName))
      socket.on('gtyping', ({ groupId, name: typer }) => alive && setTypingFor(groupId, typer))
    }

    setup()

    return () => {
      alive = false
      typingTimers.current.forEach(clearTimeout)
      socket.disconnect()
    }
  }, [name]) // eslint-disable-line react-hooks/exhaustive-deps

  const sealWith = async (keyPromise, env) => {
    if (!keyPromise) return null
    return encrypt(await keyPromise, JSON.stringify(env))
  }

  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const sendEnvelope = useCallback(async (target, env, { localEntry = true } = {}) => {
    const socket = socketRef.current
    if (!socket) return
    const msgId = crypto.randomUUID()
    const ts = Date.now()
    const group = groupsRef.current.find((g) => g.id === target)

    if (group) {
      const payloads = {}
      for (const m of group.members) {
        const sealed = await sealWith(
          m.id === clientId ? selfKeyRef.current : peerKeyRef.current.get(m.id),
          env
        )
        if (sealed) payloads[m.id] = sealed
      }
      socket.emit('gdm', { groupId: target, id: msgId, payloads, ts })
    } else {
      const sealed = await sealWith(peerKeyRef.current.get(target), env)
      if (!sealed) return
      const selfPayload = await sealWith(selfKeyRef.current, { ...env, _to: target })
      socket.emit('dm', { to: target, id: msgId, payload: sealed, selfPayload, ts })
    }

    if (localEntry) {
      addEntry(target, { id: msgId, kind: 'self', body: toBody(env), ts, status: 'sent' }, false)
    }
    return msgId
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((target, env) => sendEnvelope(target, env), [sendEnvelope])

  const react = useCallback((target, msgId, emoji) => {
    sendEnvelope(target, { t: 'react', msgId, emoji }, { localEntry: false })
    updateMessage(target, msgId, (m) => {
      const reactions = { ...m.reactions }
      if (emoji) reactions.me = emoji
      else delete reactions.me
      return { ...m, reactions }
    })
  }, [sendEnvelope]) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteForAll = useCallback((target, msgId) => {
    sendEnvelope(target, { t: 'delete', msgId }, { localEntry: false })
    updateMessage(target, msgId, (m) => ({ ...m, deleted: true, reactions: {} }))
  }, [sendEnvelope]) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteForMe = useCallback((target, msgId) => {
    patchConvo(target, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== msgId) }))
  }, [])

  const addLocalEntry = useCallback((target, body, kind = 'call') => {
    addEntry(target, { id: crypto.randomUUID(), kind, body, ts: Date.now() }, false)
  }, [])

  const createGroup = useCallback((groupName, memberIds) => {
    socketRef.current?.emit('group-create', { name: groupName, members: memberIds })
  }, [])

  const deleteGroup = useCallback((groupId) => {
    socketRef.current?.emit('group-delete', { groupId })
    setGroups((gs) => gs.filter((g) => g.id !== groupId))
  }, [])

  const leaveGroup = useCallback((groupId) => {
    socketRef.current?.emit('group-leave', { groupId })
    setGroups((gs) => gs.filter((g) => g.id !== groupId))
  }, [])

  const inviteToGroup = useCallback((groupId, memberIds) => {
    socketRef.current?.emit('group-invite', { groupId, members: memberIds })
  }, [])

  const lastTypingSent = useRef(0)
  const notifyTyping = useCallback((target) => {
    const now = Date.now()
    if (now - lastTypingSent.current <= 1200) return
    lastTypingSent.current = now
    const isGroup = groupsRef.current.some((g) => g.id === target)
    socketRef.current?.emit(isGroup ? 'gtyping' : 'typing', isGroup ? { groupId: target } : { to: target })
  }, [])

  const markRead = useCallback((target) => {
    setConvos((c) => (c[target]?.unread ? { ...c, [target]: { ...c[target], unread: 0 } } : c))
  }, [])

  const sendContactRequest = useCallback((to) => {
    socketRef.current?.emit('contact-request', { to })
  }, [])

  const acceptContactRequest = useCallback((to) => {
    socketRef.current?.emit('contact-accept', { to })
  }, [])

  const rejectContactRequest = useCallback((to) => {
    socketRef.current?.emit('contact-reject', { to })
  }, [])

  const removeContact = useCallback((to) => {
    socketRef.current?.emit('contact-remove', { to })
  }, [])

  return {
    clientId, contacts, groups, convos, safetyCode, connected, sessionReplaced, authError,
    send, react, deleteForAll, deleteForMe, addLocalEntry,
    createGroup, deleteGroup, leaveGroup, inviteToGroup,
    sendContactRequest, acceptContactRequest, rejectContactRequest, removeContact,
    notifyTyping, markRead, socketRef,
  }
}
