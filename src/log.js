// Dev-only logging: everything compiles away to a no-op in production builds.
export const debug = import.meta.env.DEV
  ? (...args) => console.log('[sable]', ...args)
  : () => {}
