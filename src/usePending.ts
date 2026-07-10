import { useCallback, useState } from 'react'

// Tracks which action keys are mid-flight so a button can disable itself and
// show a spinner until its own server round-trip (ack callback) resolves —
// keyed so multiple rows (e.g. one per contact) don't block each other.
export function usePending() {
  const [pending, setPending] = useState<Set<string>>(new Set())

  const run = useCallback((key: string, action: (done: () => void) => void) => {
    setPending((s) => (s.has(key) ? s : new Set(s).add(key)))
    const done = () => setPending((s) => {
      if (!s.has(key)) return s
      const next = new Set(s)
      next.delete(key)
      return next
    })
    action(done)
  }, [])

  return { pending, isPending: (key: string) => pending.has(key), run }
}
