// Looping call ringtone via WebAudio — two soft tones, repeating.
// No audio assets, everything synthesized. start() is safe to call repeatedly.
let ctx = null
let timer = null

const beep = (freq, at, dur) => {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(0.18, at + 0.03)
  gain.gain.setValueAtTime(0.18, at + dur - 0.06)
  gain.gain.linearRampToValueAtTime(0, at + dur)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + dur)
}

export function startRing(outgoing = false) {
  if (timer) return
  try {
    ctx = ctx ?? new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
  } catch {
    return
  }
  const pattern = () => {
    const t = ctx.currentTime + 0.05
    if (outgoing) {
      beep(430, t, 0.9) // single long ring-back tone
    } else {
      beep(740, t, 0.32)
      beep(590, t + 0.4, 0.32)
    }
  }
  pattern()
  timer = setInterval(pattern, outgoing ? 2600 : 1800)
}

export function stopRing() {
  clearInterval(timer)
  timer = null
}
