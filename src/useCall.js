import { useCallback, useEffect, useRef, useState } from 'react'
import { startRing, stopRing } from './ring.js'

// WebRTC calls: 1:1 and group mesh. Media is peer-to-peer and DTLS-SRTP
// encrypted by the browser; the relay only carries SDP/ICE and ring events.
// Group calls are a full mesh — fine for the 2–6 people a private group has.
// ponytail: mesh only; an SFU is the upgrade path if groups grow past ~8.
// TURN matters in India: Jio/Airtel carrier-grade NAT blocks direct P2P for
// many pairs — openrelay is a free public TURN that gets those calls through.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:staticauth.openrelay.metered.ca:80',
        'turn:staticauth.openrelay.metered.ca:443',
        'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayprojectsecret',
    },
  ],
}

export function useCall(socketRef, onLog) {
  // { status:'idle' } | { status:'incoming'|'outgoing'|'active', mode:'direct'|'group', peerId?, groupId?, video }
  const [call, setCall] = useState({ status: 'idle' })
  const [localStream, setLocalStream] = useState(null)
  const [remoteStreams, setRemoteStreams] = useState({}) // peerId -> stream
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [sharers, setSharers] = useState({}) // remote peerId -> true

  const pcs = useRef(new Map()) // peerId -> RTCPeerConnection
  const pendingIce = useRef(new Map()) // peerId -> [candidates]
  const localRef = useRef(null)
  const screenRef = useRef(null)
  const stopShareRef = useRef(null)
  const offerRef = useRef(null)
  const activeSince = useRef(0)
  const callRef = useRef(call)
  callRef.current = call
  const logRef = useRef(onLog)
  logRef.current = onLog

  useEffect(() => {
    if (call.status === 'incoming') startRing(false)
    else if (call.status === 'outgoing') startRing(true)
    else stopRing()
    return stopRing
  }, [call.status])

  const teardown = useCallback(() => {
    pcs.current.forEach((pc) => pc.close())
    pcs.current.clear()
    pendingIce.current.clear()
    localRef.current?.getTracks().forEach((t) => t.stop())
    localRef.current = null
    screenRef.current?.getTracks().forEach((t) => t.stop())
    screenRef.current = null
    offerRef.current = null
    activeSince.current = 0
    setLocalStream(null)
    setRemoteStreams({})
    setMicOn(true)
    setCamOn(true)
    setSharing(false)
    setSharers({})
    setCall({ status: 'idle' })
  }, [])

  const logEnd = (kind) => {
    const { peerId, groupId, status } = callRef.current
    const target = groupId ?? peerId
    if (!target) return
    if (status === 'active') logRef.current?.(target, { kind: 'ended', dur: Date.now() - activeSince.current })
    else logRef.current?.(target, { kind })
  }

  const getMedia = async (video) => {
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true })
    localRef.current = stream
    setLocalStream(stream)
    return stream
  }

  const makePc = (peerId) => {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    pcs.current.set(peerId, pc)
    localRef.current?.getTracks().forEach((t) => pc.addTrack(t, localRef.current))
    // if a screen share is running, newcomers should see the screen, not the camera
    const screenTrack = screenRef.current?.getVideoTracks()[0]
    if (screenTrack) {
      pc.getSenders().find((s) => s.track?.kind === 'video')?.replaceTrack(screenTrack)
      socketRef.current?.emit('share-state', { to: peerId, sharing: true })
    }
    pc.onicecandidate = (e) =>
      e.candidate && socketRef.current?.emit('call-ice', { to: peerId, candidate: e.candidate })
    pc.ontrack = (e) => setRemoteStreams((s) => ({ ...s, [peerId]: e.streams[0] }))
    pc.onconnectionstatechange = () => {
      if (!['failed', 'closed'].includes(pc.connectionState)) return
      dropPeer(peerId)
      if (callRef.current.mode === 'direct') {
        logEnd('ended')
        teardown()
      }
    }
    return pc
  }

  const dropPeer = (peerId) => {
    pcs.current.get(peerId)?.close()
    pcs.current.delete(peerId)
    pendingIce.current.delete(peerId)
    setRemoteStreams((s) => {
      const next = { ...s }
      delete next[peerId]
      return next
    })
    setSharers((s) => {
      const next = { ...s }
      delete next[peerId]
      return next
    })
  }

  const flushIce = async (peerId) => {
    const pc = pcs.current.get(peerId)
    for (const candidate of pendingIce.current.get(peerId) ?? []) {
      try {
        await pc.addIceCandidate(candidate)
      } catch { /* stale */ }
    }
    pendingIce.current.delete(peerId)
  }

  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return

    const onOffer = async ({ from, sdp, video, group }) => {
      const cur = callRef.current
      // mesh: an offer for the group call I'm already in — answer silently
      if (group && cur.status === 'active' && cur.groupId === group) {
        const pc = makePc(from)
        await pc.setRemoteDescription(sdp)
        await flushIce(from)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socket.emit('call-answer', { to: from, sdp: answer, group })
        return
      }
      if (cur.status !== 'idle') {
        socket.emit('call-decline', { to: from, busy: true })
        return
      }
      offerRef.current = sdp
      setCall({ status: 'incoming', mode: 'direct', peerId: from, video: video !== false })
    }

    const onAnswer = async ({ from, sdp }) => {
      const pc = pcs.current.get(from)
      if (!pc) return
      await pc.setRemoteDescription(sdp)
      await flushIce(from)
      if (callRef.current.mode === 'direct' && callRef.current.status === 'outgoing') {
        activeSince.current = Date.now()
        setCall((c) => ({ ...c, status: 'active' }))
      }
    }

    const onIce = async ({ from, candidate }) => {
      const pc = pcs.current.get(from)
      if (pc?.remoteDescription) {
        try {
          await pc.addIceCandidate(candidate)
        } catch { /* stale */ }
      } else {
        pendingIce.current.set(from, [...(pendingIce.current.get(from) ?? []), candidate])
      }
    }

    const onEnd = ({ from }) => {
      const cur = callRef.current
      if (cur.mode === 'group') {
        dropPeer(from)
        return
      }
      if (cur.peerId !== from) return
      if (cur.status === 'incoming') logEnd('missed')
      else if (cur.status === 'outgoing') logEnd('declined')
      else logEnd('ended')
      teardown()
    }

    // ----- group call events -----
    const onGroupRing = ({ groupId, from, name }) => {
      if (callRef.current.status !== 'idle') return
      setCall({ status: 'incoming', mode: 'group', groupId, peerId: from, callerName: name, video: true })
    }

    const onGroupJoin = async ({ groupId, from }) => {
      const cur = callRef.current
      if (cur.mode !== 'group' || cur.groupId !== groupId || cur.status !== 'active') return
      // existing participants offer to the newcomer
      const pc = makePc(from)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socketRef.current?.emit('call-offer', { to: from, sdp: offer, group: groupId })
    }

    const onGroupLeave = ({ groupId, from }) => {
      const cur = callRef.current
      if (cur.groupId !== groupId) return
      if (cur.status === 'incoming' && cur.peerId === from) {
        // the caller gave up before we answered
        logEnd('missed')
        teardown()
        return
      }
      dropPeer(from)
    }

    // presenter announcements: track remote sharers, and enforce a single
    // presenter — if someone else starts sharing while we are, we stop
    const onShareState = ({ from, sharing: isSharing }) => {
      setSharers((s) => {
        const next = { ...s }
        if (isSharing) next[from] = true
        else delete next[from]
        return next
      })
      if (isSharing && screenRef.current) stopShareRef.current?.()
    }

    socket.on('call-offer', onOffer)
    socket.on('call-answer', onAnswer)
    socket.on('call-ice', onIce)
    socket.on('call-end', onEnd)
    socket.on('call-decline', onEnd)
    socket.on('gcall-ring', onGroupRing)
    socket.on('gcall-join', onGroupJoin)
    socket.on('gcall-leave', onGroupLeave)
    socket.on('share-state', onShareState)

    return () => {
      socket.off('call-offer', onOffer)
      socket.off('call-answer', onAnswer)
      socket.off('call-ice', onIce)
      socket.off('call-end', onEnd)
      socket.off('call-decline', onEnd)
      socket.off('gcall-ring', onGroupRing)
      socket.off('gcall-join', onGroupJoin)
      socket.off('gcall-leave', onGroupLeave)
      socket.off('share-state', onShareState)
    }
  }, [socketRef, teardown]) // eslint-disable-line react-hooks/exhaustive-deps

  const startCall = useCallback(async (peerId, video = true) => {
    if (callRef.current.status !== 'idle') return
    try {
      await getMedia(video)
    } catch {
      logRef.current?.(peerId, { kind: 'media-error' })
      return
    }
    const pc = makePc(peerId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    socketRef.current?.emit('call-offer', { to: peerId, sdp: offer, video })
    setCall({ status: 'outgoing', mode: 'direct', peerId, video })
  }, [socketRef]) // eslint-disable-line react-hooks/exhaustive-deps

  const startGroupCall = useCallback(async (groupId) => {
    if (callRef.current.status !== 'idle') return
    try {
      await getMedia(true)
    } catch {
      logRef.current?.(groupId, { kind: 'media-error' })
      return
    }
    socketRef.current?.emit('gcall-ring', { groupId })
    activeSince.current = Date.now()
    setCall({ status: 'active', mode: 'group', groupId, video: true })
  }, [socketRef]) // eslint-disable-line react-hooks/exhaustive-deps

  const accept = useCallback(async () => {
    const { peerId, groupId, video, mode } = callRef.current
    try {
      await getMedia(video)
    } catch {
      logRef.current?.(groupId ?? peerId, { kind: 'media-error' })
      if (mode === 'direct') socketRef.current?.emit('call-decline', { to: peerId })
      teardown()
      return
    }
    if (mode === 'group') {
      // announce; everyone already in the call offers to us
      socketRef.current?.emit('gcall-join', { groupId })
      activeSince.current = Date.now()
      setCall({ status: 'active', mode: 'group', groupId, video })
      return
    }
    const pc = makePc(peerId)
    await pc.setRemoteDescription(offerRef.current)
    await flushIce(peerId)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    socketRef.current?.emit('call-answer', { to: peerId, sdp: answer })
    activeSince.current = Date.now()
    setCall({ status: 'active', mode: 'direct', peerId, video })
  }, [socketRef, teardown]) // eslint-disable-line react-hooks/exhaustive-deps

  const decline = useCallback(() => {
    const { mode, peerId } = callRef.current
    if (mode === 'direct') socketRef.current?.emit('call-decline', { to: peerId })
    logEnd('missed')
    teardown()
  }, [socketRef, teardown]) // eslint-disable-line react-hooks/exhaustive-deps

  const hangup = useCallback(() => {
    const { mode, peerId, groupId } = callRef.current
    if (mode === 'group') socketRef.current?.emit('gcall-leave', { groupId })
    else socketRef.current?.emit('call-end', { to: peerId })
    logEnd('cancelled')
    teardown()
  }, [socketRef, teardown]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMic = useCallback(() => {
    localRef.current?.getAudioTracks().forEach((t) => { t.enabled = !t.enabled })
    setMicOn((v) => !v)
  }, [])

  const toggleCam = useCallback(() => {
    localRef.current?.getVideoTracks().forEach((t) => { t.enabled = !t.enabled })
    setCamOn((v) => !v)
  }, [])

  // swap the outgoing video track on every connection; browser picker offers
  // tab / window / entire screen natively
  const announceShare = (isSharing) => {
    for (const peerId of pcs.current.keys()) {
      socketRef.current?.emit('share-state', { to: peerId, sharing: isSharing })
    }
  }

  const stopShare = useCallback(async () => {
    if (!screenRef.current) return
    screenRef.current.getTracks().forEach((t) => t.stop())
    screenRef.current = null
    const camTrack = localRef.current?.getVideoTracks()[0]
    for (const pc of pcs.current.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender && camTrack) await sender.replaceTrack(camTrack)
    }
    announceShare(false)
    setLocalStream(localRef.current)
    setSharing(false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  stopShareRef.current = stopShare

  const toggleShare = useCallback(async () => {
    if (screenRef.current) return stopShare()
    let display
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    } catch {
      return // user cancelled the picker
    }
    const track = display.getVideoTracks()[0]
    screenRef.current = display
    track.onended = stopShare // browser's own "Stop sharing" button
    for (const pc of pcs.current.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(track)
    }
    announceShare(true)
    setLocalStream(new MediaStream([track, ...(localRef.current?.getAudioTracks() ?? [])]))
    setSharing(true)
  }, [stopShare]) // eslint-disable-line react-hooks/exhaustive-deps

  // ring one group member into an ongoing group call
  const inviteToCall = useCallback((memberId) => {
    const { groupId, status } = callRef.current
    if (status === 'active' && groupId) {
      socketRef.current?.emit('gcall-ring', { groupId, to: memberId })
    }
  }, [socketRef]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    call, localStream, remoteStreams, micOn, camOn, sharing, sharers,
    startCall, startGroupCall, accept, decline, hangup, toggleMic, toggleCam, toggleShare, inviteToCall,
  }
}
