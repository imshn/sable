// Deterministic per-person hue so avatars are easier to tell apart at a
// glance in a list or call grid, without needing real profile photos.
export function avatarHue(seed) {
  let h = 0
  const s = String(seed ?? '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

export const avatarBg = (seed) => `hsl(${avatarHue(seed)} 55% 42%)`
