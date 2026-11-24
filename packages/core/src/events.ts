export interface EventBus<E> {
  /** Returns the unsubscribe function. */
  on<K extends keyof E>(type: K, handler: (payload: E[K]) => void): () => void
  emit<K extends keyof E>(type: K, payload: E[K]): void
}

export function createEventBus<E>(): EventBus<E> {
  const handlers = new Map<keyof E, Set<(payload: any) => void>>()
  return {
    on(type, handler) {
      let set = handlers.get(type)
      if (!set) handlers.set(type, (set = new Set()))
      set.add(handler)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      handlers.get(type)?.forEach((handler) => handler(payload))
    },
  }
}
