import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'
import {
  generateKeyPair,
  exportPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  fingerprint,
  b64decode,
} from './crypto.js'

// Per-tab identity: survives reloads, but two tabs are two distinct users
// (localStorage would make same-browser tabs shadow each other on the relay).
export function getClientId() {
  let id = sessionStorage.getItem('sable-id')
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem('sable-id', id)
  }
  return id
}

const emptyConvo = () => ({ messages: [], unread: 0, typing: null, lastTs: 0 })

// Content envelopes (encrypted as JSON): text / file / loc (+fwd flag)
// Control envelopes: { t: 'react', msgId, emoji|null } and { t: 'delete', msgId }
// Local-only kinds: 'call' (call logs) and 'sys' (group notices)
const toBody = (env) => {
  if (env.t === 'file') {
    const url = URL.createObjectURL(new Blob([b64decode(env.data)], { type: env.mime }))
    return { ...env, data: undefined, url }
  }
  return env
}

export function useChat(name) {
  const [contacts, setContacts] = useState([]) // online users, excluding self
  const [groups, setGroups] = useState([]) // [{ id, name, owner, members: [{id,name}] }]
  const [convos, setConvos] = useState({}) // (peerId | groupId) -> convo
  const [safetyCode, setSafetyCode] = useState('')
  const [connected, setConnected] = useState(false)

  const socketRef = useRef(null)
  const keysRef = useRef(new Map()) // peerId -> Promise<CryptoKey>
  const pubkeysRef = useRef(new Map())
  const typingTimers = useRef(new Map())
  const clientId = getClientId()

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

  // apply a decrypted envelope; returns true if it was a control message
  const applyControl = (key, from, env) => {
    if (env?.t === 'react') {
      updateMessage(key, env.msgId, (m) => {
        const reactions = { ...m.reactions }
        if (env.emoji) reactions[from] = env.emoji
        else delete reactions[from]
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
    // same-origin by default (vite proxies /socket.io in dev); a hosted
    // frontend points at its relay via VITE_RELAY_URL
    const socket = import.meta.env.VITE_RELAY_URL ? io(import.meta.env.VITE_RELAY_URL) : io()
    socketRef.current = socket

    const setup = async () => {
      const keyPair = await generateKeyPair()
      const pubKey = await exportPublicKey(keyPair)
      if (!alive) return
      setSafetyCode(await fingerprint(pubKey))

      socket.on('connect', () => {
        if (!alive) return
        setConnected(true)
        socket.emit('hello', { id: clientId, name, pubKey })
      })
      socket.on('disconnect', () => alive && setConnected(false))

      socket.on('directory', (list) => {
        if (!alive) return
        const peers = list.filter((u) => u.id !== clientId)
        for (const peer of peers) {
          const jwkStr = JSON.stringify(peer.pubKey)
          if (pubkeysRef.current.get(peer.id) !== jwkStr) {
            pubkeysRef.current.set(peer.id, jwkStr)
            keysRef.current.set(peer.id, deriveSharedKey(keyPair.privateKey, peer.pubKey))
          }
        }
        setContacts(peers.map(({ id, name: n }) => ({ id, name: n })))
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
        const keyPromise = keysRef.current.get(from)
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

  // encrypt an envelope for one peer
  const sealFor = async (peerId, env) => {
    const keyPromise = keysRef.current.get(peerId)
    if (!keyPromise) return null
    return encrypt(await keyPromise, JSON.stringify(env))
  }

  const groupsRef = useRef(groups)
  groupsRef.current = groups

  // target: peerId or groupId. Encrypts per recipient; groups fan out pairwise.
  const sendEnvelope = useCallback(async (target, env, { localEntry = true } = {}) => {
    const socket = socketRef.current
    if (!socket) return
    const msgId = crypto.randomUUID()
    const ts = Date.now()
    const group = groupsRef.current.find((g) => g.id === target)

    if (group) {
      const payloads = {}
      for (const m of group.members) {
        if (m.id === clientId) continue
        const sealed = await sealFor(m.id, env)
        if (sealed) payloads[m.id] = sealed
      }
      socket.emit('gdm', { groupId: target, id: msgId, payloads, ts })
    } else {
      const sealed = await sealFor(target, env)
      if (!sealed) return
      socket.emit('dm', { to: target, id: msgId, payload: sealed, ts })
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

  return {
    clientId, contacts, groups, convos, safetyCode, connected,
    send, react, deleteForAll, deleteForMe, addLocalEntry,
    createGroup, deleteGroup, leaveGroup, inviteToGroup,
    notifyTyping, markRead, socketRef,
  }
}
