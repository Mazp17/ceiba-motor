export interface EventBus<E> {
  /** Returns the unsubscribe function. */
  on<K extends keyof E>(type: K, handler: (payload: E[K]) => void): () => void
  emit<K extends keyof E>(type: K, payload: E[K]): void
}

export function createEventBus<E>(): EventBus<E> {
  // biome-ignore lint/suspicious/noExplicitAny: handlers of every event type share one map
  const handlers = new Map<keyof E, Set<(payload: any) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set()
      handlers.set(type, set)
      set.add(handler)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      for (const handler of handlers.get(type) ?? []) handler(payload)
    },
  }
}
