// In-memory mirror of feature_flags/system_config — loaded once at boot and
// kept in sync by admin.ts on every write, so hot paths (message send, call
// offer, registration) never do a DB round-trip just to check a flag.
import { store } from './db.js'

export const flags: Record<string, boolean> = {}
export const config: Record<string, string> = {}

export async function loadFlags(): Promise<void> {
  Object.assign(flags, await store.getFeatureFlags())
  Object.assign(config, await store.getSystemConfig())
}

// Unknown/not-yet-loaded flags default to enabled — a missing row should
// never silently disable a feature.
export const flagEnabled = (key: string): boolean => flags[key] !== false

export function configNumber(key: string, fallback: number): number {
  const n = Number(config[key])
  return Number.isFinite(n) ? n : fallback
}
