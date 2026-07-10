import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { startRing, stopRing } from './ring.ts'
import { debug } from './log.ts'
import type { CallState, CallMode, QualitySample, QualityLevel } from './types.ts'

// WebRTC calls: 1:1 and group mesh. Media is peer-to-peer and DTLS-SRTP
// encrypted by the browser; the relay only carries SDP/ICE and ring events.
// Group calls are a full mesh — fine for the 2–6 people a private group has.
// ponytail: mesh only; an SFU is the upgrade path if groups grow past ~8.
// TURN matters in India: Jio/Airtel carrier-grade NAT blocks direct P2P for
// many pairs. The relay's /turn endpoint issues fresh credentials (configured
// server-side); STUN alone is the fallback if none are configured.
const RELAY_BASE = import.meta.env.VITE_RELAY_URL ?? ''
let cachedTurn: RTCIceServer[] | null = null
async function rtcConfig(): Promise<RTCConfiguration> {
  if (!cachedTurn) {
    try {
      const r = await fetch(`${RELAY_BASE}/turn`, { signal: AbortSignal.timeout(6000) })
      cachedTurn = (await r.json()) ?? []
    } catch {
      cachedTurn = []
    }
  }
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...(cachedTurn ?? [])] }
}

export type CallLogKind = 'ended' | 'missed' | 'declined' | 'cancelled' | 'media-error'
export type OnLog = (target: string, log: { kind: CallLogKind; dur?: number }) => void

interface OfferPayload {
  from: string
  sdp: RTCSessionDescriptionInit
  video?: boolean
  group?: string
  restart?: boolean
}

interface AnswerPayload {
  from: string
  sdp: RTCSessionDescriptionInit
}

interface IcePayload {
  from: string
  candidate: RTCIceCandidateInit
}

interface EndPayload {
  from: string
}

interface GroupRingPayload {
  groupId: string
  from: string
  name?: string
}

interface GroupJoinLeavePayload {
  groupId: string
  from: string
}

interface ShareStatePayload {
  from: string
  sharing: boolean
}

interface CamMicStatePayload {
  from: string
  camOn?: boolean
  micOn?: boolean
}

export function useCall(socketRef: RefObject<Socket | null>, connected: boolean, myId: string, onLog: OnLog) {
  const [call, setCall] = useState<CallState>({ status: 'idle' })
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [sharers, setSharers] = useState<Record<string, true>>({})
  const [camsOff, setCamsOff] = useState<Record<string, true>>({})
  const [micsOff, setMicsOff] = useState<Record<string, true>>({})
  const [quality, setQuality] = useState<QualitySample | null>(null)
  const [lowBandwidth, setLowBandwidth] = useState(false)
  const restartAttempts = useRef(new Map<string, number>())
  const statsPrev = useRef(new Map<string, { lost: number; received: number; bytes: number; ts: number }>())
  const lowBwStreak = useRef(0)

  const pcs = useRef(new Map<string, RTCPeerConnection>())
  const pendingIce = useRef(new Map<string, RTCIceCandidateInit[]>())
  const localRef = useRef<MediaStream | null>(null)
  const screenRef = useRef<MediaStream | null>(null)
  const stopShareRef = useRef<() => Promise<void>>(async () => {})
  const offerRef = useRef<RTCSessionDescriptionInit | null>(null)
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

  // Connection health: sample getStats every 2s across all peers, report the
  // worst link (RTT / packet loss / inbound bitrate), and drop our own video
  // after three consecutive starved samples so audio survives bad networks.
  useEffect(() => {
    if (call.status !== 'active') return
    const LEVELS: Record<QualityLevel, number> = { excellent: 2, good: 1, poor: 0 }
    const interval = setInterval(async () => {
      let worst: QualitySample | null = null
      for (const [peerId, pc] of pcs.current) {
        if (pc.connectionState !== 'connected') continue
        let stats: RTCStatsReport
        try {
          stats = await pc.getStats()
        } catch {
          continue
        }
        let rtt: number | null = null
        let lost = 0
        let received = 0
        let bytes = 0
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime != null) {
            rtt = s.currentRoundTripTime * 1000
          }
          if (s.type === 'inbound-rtp') {
            lost += s.packetsLost ?? 0
            received += s.packetsReceived ?? 0
            bytes += s.bytesReceived ?? 0
          }
        })
        const prev = statsPrev.current.get(peerId)
        statsPrev.current.set(peerId, { lost, received, bytes, ts: Date.now() })
        if (!prev) continue
        const dLost = Math.max(0, lost - prev.lost)
        const dRecv = Math.max(0, received - prev.received)
        const lossPct = dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : 0
        const kbps = Math.round(Math.max(0, ((bytes - prev.bytes) * 8) / (Date.now() - prev.ts)))
        const level: QualityLevel =
          lossPct > 6 || (rtt ?? 0) > 500 ? 'poor' : lossPct > 2 || (rtt ?? 0) > 250 ? 'good' : 'excellent'
        const sample: QualitySample = { level, rttMs: rtt != null ? Math.round(rtt) : null, lossPct: +lossPct.toFixed(1), kbps }
        if (!worst || LEVELS[sample.level] < LEVELS[worst.level]) worst = sample
      }
      if (!worst) return
      setQuality(worst)

      // audio-only fallback: starved link while our camera is still sending
      const sendingVideo = localRef.current?.getVideoTracks().some((t) => t.enabled)
      if (worst.level === 'poor' && worst.kbps < 120 && sendingVideo && !screenRef.current) {
        lowBwStreak.current++
        if (lowBwStreak.current >= 3) {
          debug('low bandwidth — dropping to audio only', worst)
          setCamEnabled(false)
          setLowBandwidth(true)
        }
      } else {
        lowBwStreak.current = 0
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [call.status]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setCamsOff({})
    setMicsOff({})
    setQuality(null)
    setLowBandwidth(false)
    restartAttempts.current.clear()
    statsPrev.current.clear()
    lowBwStreak.current = 0
    setCall({ status: 'idle' })
  }, [])

  // ICE failure recovery: restart + renegotiate instead of dropping the call.
  // Only the peer with the lexically smaller id initiates, so both sides
  // detecting the failure never produce colliding offers (no glare).
  const attemptRestart = async (peerId: string) => {
    const cur = callRef.current
    const pc = pcs.current.get(peerId)
    if (!pc || (cur.status !== 'active' && cur.status !== 'outgoing')) return
    const n = (restartAttempts.current.get(peerId) ?? 0) + 1
    restartAttempts.current.set(peerId, n)
    if (n > 3) {
      debug('ice restart gave up for', peerId)
      if (cur.mode === 'direct') {
        logEnd('ended')
        teardown()
      } else {
        dropPeer(peerId)
      }
      return
    }
    if (!(myId < peerId)) return // the other side initiates
    debug('ice restart attempt', n, 'for', peerId)
    try {
      pc.restartIce()
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socketRef.current?.emit('call-offer', {
        to: peerId,
        sdp: offer,
        restart: true,
        group: cur.mode === 'group' ? cur.groupId : undefined,
      })
    } catch (e) {
      debug('ice restart error', (e as Error).message)
    }
  }

  const logEnd = (kind: CallLogKind) => {
    const { peerId, groupId, status } = callRef.current
    const target = groupId ?? peerId
    if (!target) return
    if (status === 'active') logRef.current?.(target, { kind: 'ended', dur: Date.now() - activeSince.current })
    else logRef.current?.(target, { kind })
  }

  const getMedia = async (video?: boolean): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true })
    localRef.current = stream
    setLocalStream(stream)
    return stream
  }

  const makePc = async (peerId: string): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection(await rtcConfig())
    pcs.current.set(peerId, pc)
    localRef.current?.getTracks().forEach((t) => pc.addTrack(t, localRef.current!))
    // if a screen share is running, newcomers should see the screen, not the camera
    const screenTrack = screenRef.current?.getVideoTracks()[0]
    if (screenTrack) {
      pc.getSenders().find((s) => s.track?.kind === 'video')?.replaceTrack(screenTrack)
      socketRef.current?.emit('share-state', { to: peerId, sharing: true })
    }
    if (localRef.current && !localRef.current.getVideoTracks().some((t) => t.enabled)) {
      socketRef.current?.emit('cam-state', { to: peerId, camOn: false })
    }
    if (localRef.current && !localRef.current.getAudioTracks().some((t) => t.enabled)) {
      socketRef.current?.emit('mic-state', { to: peerId, micOn: false })
    }
    pc.onicecandidate = (e) =>
      e.candidate && socketRef.current?.emit('call-ice', { to: peerId, candidate: e.candidate })
    pc.ontrack = (e) => setRemoteStreams((s) => ({ ...s, [peerId]: e.streams[0] }))
    pc.oniceconnectionstatechange = () => {
      debug('ice', peerId, pc.iceConnectionState)
      if (pc.iceConnectionState === 'failed') attemptRestart(peerId)
      if (['connected', 'completed'].includes(pc.iceConnectionState)) restartAttempts.current.set(peerId, 0)
    }
    pc.onconnectionstatechange = () => {
      debug('conn', peerId, pc.connectionState)
      if (pc.connectionState === 'failed') attemptRestart(peerId)
    }
    return pc
  }

  const dropPeer = (peerId: string) => {
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
    setCamsOff((s) => {
      const next = { ...s }
      delete next[peerId]
      return next
    })
    setMicsOff((s) => {
      const next = { ...s }
      delete next[peerId]
      return next
    })
  }

  const flushIce = async (peerId: string) => {
    const pc = pcs.current.get(peerId)
    for (const candidate of pendingIce.current.get(peerId) ?? []) {
      try {
        await pc?.addIceCandidate(candidate)
      } catch { /* stale */ }
    }
    pendingIce.current.delete(peerId)
  }

  useEffect(() => {
    // `socketRef` is a ref, so its identity never changes — depending on it
    // alone means this effect only ever runs once, at mount, and if the
    // socket hasn't connected yet at that exact moment, every call listener
    // below silently never registers for the rest of the session (identical
    // bug to the one fixed in InvitePage/InviteModal). `connected` is what
    // actually re-fires this once the socket is up.
    const socket = socketRef.current
    if (!connected || !socket) return

    const onOffer = async ({ from, sdp, video, group, restart }: OfferPayload) => {
      const cur = callRef.current
      // renegotiation after an ICE restart — answer on the existing connection
      if (restart) {
        const pc = pcs.current.get(from)
        if (!pc) return
        debug('answering ice restart from', from)
        await pc.setRemoteDescription(sdp)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socket.emit('call-answer', { to: from, sdp: answer })
        return
      }
      // mesh: an offer for the group call I'm already in — answer silently
      if (group && cur.status === 'active' && cur.groupId === group) {
        const pc = await makePc(from)
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

    const onAnswer = async ({ from, sdp }: AnswerPayload) => {
      const pc = pcs.current.get(from)
      if (!pc || pc.signalingState !== 'have-local-offer') return
      await pc.setRemoteDescription(sdp)
      await flushIce(from)
      if (callRef.current.mode === 'direct' && callRef.current.status === 'outgoing') {
        activeSince.current = Date.now()
        setCall((c) => ({ ...c, status: 'active' }))
      }
    }

    const onIce = async ({ from, candidate }: IcePayload) => {
      const pc = pcs.current.get(from)
      if (pc?.remoteDescription) {
        try {
          await pc.addIceCandidate(candidate)
        } catch { /* stale */ }
      } else {
        pendingIce.current.set(from, [...(pendingIce.current.get(from) ?? []), candidate])
      }
    }

    const onEnd = ({ from }: EndPayload) => {
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
    const onGroupRing = ({ groupId, from, name }: GroupRingPayload) => {
      if (callRef.current.status !== 'idle') return
      setCall({ status: 'incoming', mode: 'group', groupId, peerId: from, callerName: name, video: true })
    }

    const onGroupJoin = async ({ groupId, from }: GroupJoinLeavePayload) => {
      const cur = callRef.current
      if (cur.mode !== 'group' || cur.groupId !== groupId || cur.status !== 'active') return
      // existing participants offer to the newcomer
      const pc = await makePc(from)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socketRef.current?.emit('call-offer', { to: from, sdp: offer, group: groupId })
    }

    const onGroupLeave = ({ groupId, from }: GroupJoinLeavePayload) => {
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
    const onShareState = ({ from, sharing: isSharing }: ShareStatePayload) => {
      setSharers((s) => {
        const next = { ...s }
        if (isSharing) next[from] = true
        else delete next[from]
        return next
      })
      if (isSharing && screenRef.current) stopShareRef.current?.()
    }

    const onCamState = ({ from, camOn }: CamMicStatePayload) => {
      setCamsOff((s) => {
        const next = { ...s }
        if (camOn) delete next[from]
        else next[from] = true
        return next
      })
    }

    const onMicState = ({ from, micOn }: CamMicStatePayload) => {
      setMicsOff((s) => {
        const next = { ...s }
        if (micOn) delete next[from]
        else next[from] = true
        return next
      })
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
    socket.on('cam-state', onCamState)
    socket.on('mic-state', onMicState)

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
      socket.off('cam-state', onCamState)
      socket.off('mic-state', onMicState)
    }
  }, [socketRef, connected, teardown]) // eslint-disable-line react-hooks/exhaustive-deps

  const startCall = useCallback(async (peerId: string, video = true) => {
    if (callRef.current.status !== 'idle') return
    try {
      await getMedia(video)
    } catch {
      logRef.current?.(peerId, { kind: 'media-error' })
      return
    }
    const pc = await makePc(peerId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    socketRef.current?.emit('call-offer', { to: peerId, sdp: offer, video })
    setCall({ status: 'outgoing', mode: 'direct', peerId, video })
  }, [socketRef]) // eslint-disable-line react-hooks/exhaustive-deps

  const startGroupCall = useCallback(async (groupId: string) => {
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
      logRef.current?.((groupId ?? peerId)!, { kind: 'media-error' })
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
    const pc = await makePc(peerId!)
    await pc.setRemoteDescription(offerRef.current!)
    await flushIce(peerId!)
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

  const setMicEnabled = (enabled: boolean) => {
    localRef.current?.getAudioTracks().forEach((t) => { t.enabled = enabled })
    setMicOn(enabled)
    for (const peerId of pcs.current.keys()) {
      socketRef.current?.emit('mic-state', { to: peerId, micOn: enabled })
    }
  }

  const toggleMic = useCallback(() => {
    setMicEnabled(!(localRef.current?.getAudioTracks().some((t) => t.enabled)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setCamEnabled = (enabled: boolean) => {
    localRef.current?.getVideoTracks().forEach((t) => { t.enabled = enabled })
    setCamOn(enabled)
    for (const peerId of pcs.current.keys()) {
      socketRef.current?.emit('cam-state', { to: peerId, camOn: enabled })
    }
  }

  const toggleCam = useCallback(() => {
    setCamEnabled(!(localRef.current?.getVideoTracks().some((t) => t.enabled)))
    setLowBandwidth(false) // turning the camera back on is an explicit override
    lowBwStreak.current = 0
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // swap the outgoing video track on every connection; browser picker offers
  // tab / window / entire screen natively
  const announceShare = (isSharing: boolean) => {
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
    let display: MediaStream
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
  }, [stopShare])

  // ring one group member into an ongoing group call
  const inviteToCall = useCallback((memberId: string) => {
    const { groupId, status } = callRef.current
    if (status === 'active' && groupId) {
      socketRef.current?.emit('gcall-ring', { groupId, to: memberId })
    }
  }, [socketRef]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    call, localStream, remoteStreams, micOn, camOn, sharing, sharers, camsOff, micsOff, quality, lowBandwidth,
    activeSince,
    startCall, startGroupCall, accept, decline, hangup, toggleMic, toggleCam, toggleShare, inviteToCall,
  }
}

export type UseCallReturn = ReturnType<typeof useCall>
export type { CallMode }
