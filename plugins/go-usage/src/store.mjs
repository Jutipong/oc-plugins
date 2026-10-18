// go-usage — tiny observable so the sidebar reacts to entry-owned state
// without depending on storage update semantics.

export function createObservable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get() {
      return value
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) {
        try {
          listener(value)
        } catch {
          // A broken listener must not break the others.
        }
      }
      return value
    },
    update(fn) {
      return this.set(typeof fn === "function" ? fn(value) : fn)
    },
    subscribe(listener) {
      listeners.add(listener)
      try {
        listener(value)
      } catch {
        // Initial delivery is best-effort too.
      }
      return () => listeners.delete(listener)
    },
  }
}
