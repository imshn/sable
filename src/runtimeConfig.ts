// Operator-configurable limits fetched once at boot from the public
// /config endpoint (feature flags are enforced server-side already; this
// exists so client-side checks like the file-size limit stay in sync with
// whatever the admin panel has set, instead of a hardcoded constant).
const RELAY = import.meta.env.VITE_RELAY_URL ?? ''

export const runtimeConfig = { maxUploadMb: 15, maxGroupParticipants: 32 }

export async function loadRuntimeConfig(): Promise<void> {
  try {
    const res = await fetch(`${RELAY}/config`)
    if (!res.ok) return
    const data = await res.json()
    if (data.maxUploadMb) runtimeConfig.maxUploadMb = data.maxUploadMb
    if (data.maxGroupParticipants) runtimeConfig.maxGroupParticipants = data.maxGroupParticipants
  } catch { /* keep defaults */ }
}
