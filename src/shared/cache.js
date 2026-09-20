/**
 * Bounded LRU used by both halves of dsh-translator: the host keeps finished
 * translations keyed by (source, language, route), the browser keeps the ones it
 * has already rendered. Looking at the same paragraph twice is the normal case,
 * and a re-render must never cost another model call.
 *
 * Dependency-free and side-effect-free so it is directly unit-testable.
 *
 * @module dsh-translator/shared/cache
 */

/** Least-recently-used map with a hard entry cap. */
export class LruCache {
  #map = new Map()
  #limit

  /**
   * @param limit - maximum retained entries (at least 1).
   */
  constructor(limit = 500) {
    this.#limit = Math.max(1, Math.floor(limit) || 1)
  }

  /**
   * @param key - cache key.
   * @returns the cached value, refreshed to most-recently-used; undefined on a miss.
   */
  get(key) {
    if (!this.#map.has(key)) return undefined
    const value = this.#map.get(key)
    this.#map.delete(key)
    this.#map.set(key, value)
    return value
  }

  /**
   * Insert or refresh one entry, evicting the least recently used past the cap.
   * @param key - cache key.
   * @param value - value to retain.
   */
  set(key, value) {
    if (this.#map.has(key)) this.#map.delete(key)
    this.#map.set(key, value)
    while (this.#map.size > this.#limit) {
      const oldest = this.#map.keys().next()
      if (oldest.done === true) break
      this.#map.delete(oldest.value)
    }
  }

  /** @param key - cache key. @returns whether the key is retained. */
  has(key) {
    return this.#map.has(key)
  }

  /** Drop every entry. */
  clear() {
    this.#map.clear()
  }

  /** @returns the number of retained entries. */
  get size() {
    return this.#map.size
  }
}

/**
 * Cache key for one translation: the same source in the same language through the
 * same route always produces the same answer, so all three belong in the key.
 * @param text - the (already masked) source text.
 * @param target - the target language label.
 * @param route - `{provider, model}`.
 * @returns a collision-resistant composite key.
 */
export function translationKey(text, target, route) {
  return `${route?.provider ?? '?'}\u0000${route?.model ?? '?'}\u0000${target}\u0000${text}`
}
