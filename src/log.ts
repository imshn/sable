// Dev-only logging: everything compiles away to a no-op in production builds.
export const debug: (...args: unknown[]) => void = import.meta.env.DEV
  ? (...args: unknown[]) => console.log('[sable]', ...args)
  : () => {}
