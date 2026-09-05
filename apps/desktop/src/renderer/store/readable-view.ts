export interface ReadableView<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/**
 * A named external-store view with reference-based publication.
 *
 * Values are assembled by the projection that owns them. Keeping the equality
 * rule here deliberately small makes every invalidation visible at that
 * boundary instead of hiding application work in an arbitrary selector.
 */
export class MutableView<T> implements ReadableView<T> {
  #value: T
  readonly #listeners = new Set<() => void>()

  constructor(value: T) {
    this.#value = value
  }

  getSnapshot = (): T => this.#value

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  publish(value: T): void {
    if (Object.is(value, this.#value)) return
    this.#value = value
    for (const listener of this.#listeners) listener()
  }
}
