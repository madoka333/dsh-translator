/**
 * dsh-translator client shared state: the per-session reference list and the
 * persisted UI settings.
 *
 * Both are plain observable stores (snapshot + subscribe) so the same instance
 * renders the sidebar pane, the tab title, the settings row, and the fallback
 * card without any framework coupling. Neither ever throws: a storage failure
 * degrades to memory-only.
 *
 * @module dsh-translator/client/stores
 */

/** localStorage key holding the settings blob. */
const SETTINGS_KEY = 'dsh-translator:settings'

/** localStorage key prefix holding one session's reference list. */
const REFS_PREFIX = 'dsh-translator:refs:'

/** localStorage key prefix holding one session's unsent composer draft. */
const DRAFT_PREFIX = 'dsh-translator:draft:'

/** How many references one session keeps before the oldest is dropped. */
const MAX_REFS = 100

/** In-memory result cache bound (per page). */
const MAX_CACHE = 200

/** Default settings; `targetLanguage` mirrors the host default. */
export const DEFAULT_SETTINGS = {
  /** Target language code. */
  targetLanguage: 'zh-CN',
  /** Source language code, or `'auto'` (detect it from the text). */
  sourceLanguage: 'auto',
  /** Translation gear: a `TRANSLATION_MODES` id. */
  mode: 'general',
  /** Free-text requirement behind the `custom` gear. */
  customInstruction: '',
  trigger: 'selection',
  shortcut: 'Ctrl+Shift+T',
  maskCode: true,
  includeReasoning: true,
  includeText: true,
}

/** The gear a card carries when it was stored before gears existed. */
export const LEGACY_MODE = 'general'

/** The source a card carries when it was stored before detection existed. */
export const LEGACY_SOURCE = 'auto'

/** Read one JSON blob from localStorage without throwing. */
function readJson(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === null || raw === undefined) return fallback
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Write one JSON blob to localStorage without throwing. */
function writeJson(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — state stays in memory for this page */
  }
}

/** Remove one key without throwing. */
function removeKey(key) {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Minimal observable store over an immutable snapshot. */
class Observable {
  #snapshot
  #listeners = new Set()
  /** @param initial - the first snapshot. */
  constructor(initial) {
    this.#snapshot = initial
  }
  /** @returns the current snapshot (reference-stable until a commit). */
  getSnapshot() {
    return this.#snapshot
  }
  /**
   * @param listener - synchronous invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  /** Replace the snapshot and notify. */
  commit(next) {
    this.#snapshot = next
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        /* a broken listener must not break the commit */
      }
    }
  }
}

/**
 * Stable identity of a reference: one card per (Session, text).
 *
 * The language pair and the gear are NOT part of it any more. They used to be —
 * a card was identified by the text plus the target language — but changing
 * either one re-translates the cards in place (that is what makes a gear switch
 * an A/B comparison instead of a pile of duplicates), so they describe the
 * answer, not the card. Answer identity lives in {@link answerKeyOf}.
 *
 * @param text - the normalized source text.
 * @param sessionKey - the storage namespace.
 * @returns the card's key.
 */
export function refKey(text, sessionKey) {
  let hash = 5381
  const input = `${sessionKey}\u0000${text}`
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  return `${(hash >>> 0).toString(36)}:${input.length}`
}

/**
 * Identity of one ANSWER: same text, same target, same gear, same source hint ⇒
 * the same translation, and the in-page cache must not confuse two of them.
 *
 * Mirror of the host's `translationKey`, minus the route (the browser does not
 * care which model answered — a finished card is a finished card).
 *
 * @param spec - `{lang, mode, sourceLang}` as stored on the reference.
 * @param text - the source text.
 * @returns the cache key.
 */
export function answerKeyOf(spec, text) {
  const mode = spec?.mode ?? LEGACY_MODE
  const source = spec?.sourceLang ?? LEGACY_SOURCE
  return `${spec?.lang ?? ''}\u0000${mode}\u0000${source}\u0000${text}`
}

/** The spec of one stored reference, with the pre-beta.2 defaults filled in. */
export function specOfRef(ref) {
  return {
    lang: ref?.lang ?? '',
    mode: ref?.mode ?? LEGACY_MODE,
    sourceLang: ref?.sourceLang ?? LEGACY_SOURCE,
  }
}

/** Whether a card already carries this exact pair and gear. */
function sameSpec(spec, ref) {
  const current = specOfRef(ref)
  return spec.lang === current.lang && spec.mode === current.mode && spec.sourceLang === current.sourceLang
}

/** UI settings store, persisted under one localStorage key. */
export class SettingsStore extends Observable {
  /** Load the persisted settings, falling back to the defaults. */
  constructor() {
    const stored = readJson(SETTINGS_KEY, {})
    super({ ...DEFAULT_SETTINGS, ...stored })
  }
  /**
   * Merge one partial update and persist.
   * @param patch - the changed fields.
   */
  update(patch) {
    const next = { ...this.getSnapshot(), ...patch }
    writeJson(SETTINGS_KEY, next)
    this.commit(next)
  }
}

/**
 * Read one session's unsent composer draft.
 *
 * The composer at the bottom of the pane stages text the user has typed or pasted
 * but not yet committed. Losing it to a page refresh (or to switching Sessions and
 * back) is the kind of small betrayal that makes a tool feel unreliable, so the
 * draft is kept per Session next to that Session's references.
 *
 * @param sessionKey - storage namespace (the active Session id).
 * @returns the draft, or '' when there is none.
 */
export function readDraft(sessionKey) {
  const key = typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : 'default'
  const raw = readJson(`${DRAFT_PREFIX}${key}`, null)
  return typeof raw?.text === 'string' ? raw.text : ''
}

/**
 * Store one session's composer draft. An empty draft removes the key instead of
 * writing an empty blob, so "staged nothing" leaves nothing behind.
 * @param sessionKey - storage namespace.
 * @param text - the draft.
 */
export function writeDraft(sessionKey, text) {
  const key = typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : 'default'
  const value = String(text ?? '')
  if (value.trim() === '') removeKey(`${DRAFT_PREFIX}${key}`)
  else writeJson(`${DRAFT_PREFIX}${key}`, { text: value })
}

/**
 * One session's references plus the streaming machinery that fills them.
 *
 * A reference is `{key, text, kind, lang, mode, sourceLang, status, translation,
 * error, cached, routeLabel, at, sourceLabel}`; `lang` is the TARGET language,
 * `sourceLang` is the pinned source or `'auto'`, and
 * `status ∈ pending|streaming|done|error|cancelled`. Cards stored before
 * beta.2 have no `mode`/`sourceLang`; they read back as the default gear and
 * `'auto'` rather than being dropped.
 */
export class RefsStore extends Observable {
  #cache = new Map()
  #controllers = new Map()
  #sessionKey = 'default'

  /** @param sessionKey - storage namespace (the active Session id). */
  constructor(sessionKey = 'default') {
    super({ refs: [], active: null })
    this.setSession(sessionKey)
  }

  /**
   * Switch the storage namespace (session switch). Live streams of the previous
   * session are aborted; their partial text is kept in that session's storage.
   */
  setSession(sessionKey) {
    const key = typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : 'default'
    if (key === this.#sessionKey) return
    this.#abortAll()
    this.#sessionKey = key
    const stored = readJson(`${REFS_PREFIX}${key}`, { refs: [] })
    const refs = Array.isArray(stored?.refs) ? stored.refs.filter(isStoredRef).map(normalizeStoredRef) : []
    this.commit({ refs: refs.slice(0, MAX_REFS), active: refs[0]?.key ?? null })
  }

  /**
   * @returns the storage namespace this store is scoped to — the Session id, or
   * `'default'` while no Session is resolvable. Read back by the provenance lookup
   * (one chat snapshot per Session) and by the self-report.
   */
  sessionKey() {
    return this.#sessionKey
  }

  /** @returns the current references, newest first. */
  list() {
    return this.getSnapshot().refs
  }

  /** @returns the primary reference key, or null. */
  activeKey() {
    return this.getSnapshot().active
  }

  /** @param key - reference key. @returns the matching reference or undefined. */
  find(key) {
    return this.getSnapshot().refs.find((ref) => ref.key === key)
  }

  /**
   * Add one reference (deduplicated): an already-known text is revealed and
   * re-raised to the top instead of duplicated.
   * @param input - `{text, kind, lang, mode, sourceLang, sourceLabel}`.
   * @param translator - `{chunks, translate}` runner.
   * @returns the reference key.
   */
  add(input, translator) {
    const key = refKey(input.text, this.#sessionKey)
    const spec = {
      lang: input.lang,
      mode: input.mode ?? LEGACY_MODE,
      sourceLang: input.sourceLang ?? LEGACY_SOURCE,
    }
    const existing = this.find(key)
    if (existing !== undefined) {
      // Same text again: reveal the card instead of duplicating it. When its answer
      // is already in hand (finished once, or restored from storage), say so — the
      // card is the user's only evidence that this cost nothing.
      if (sameSpec(spec, existing)) {
        const answer = this.#cache.get(answerKeyOf(spec, input.text))
        const known = answer !== undefined && answer !== ''
        if (known) this.#patch(key, { translation: answer, status: 'done', error: null, cached: true })
        this.#raise(key)
        if (existing.status === 'error' || existing.status === 'cancelled') this.retry(key, translator)
        return key
      }
      // The card exists under a DIFFERENT pair/gear (the user changed the toolbar
      // and then re-selected the same text): keep one card per text, and let it
      // follow the current settings instead of showing an answer from the old gear.
      this.#raise(key)
      this.retry(key, translator, spec)
      return key
    }

    const cached = this.#cache.get(answerKeyOf(spec, input.text))
    const ref = {
      key,
      text: input.text,
      kind: input.kind ?? 'selection',
      ...spec,
      sourceLabel: input.sourceLabel ?? '',
      status: cached === undefined ? 'pending' : 'done',
      translation: cached ?? '',
      error: null,
      cached: cached !== undefined,
      routeLabel: '',
      at: Date.now(),
    }
    const refs = [ref, ...this.list()].slice(0, MAX_REFS)
    this.commit({ refs, active: key })
    this.#persist()
    if (cached === undefined) this.#run(key, translator)
    return key
  }

  /**
   * Re-run one reference from scratch.
   *
   * `patch` is how a language-pair or gear change reaches the card: the new spec
   * MUST be written onto the reference BEFORE `#run` reads it, because `#run`
   * takes the target, the gear and the source hint from the reference — retrying
   * without patching re-requests the OLD language, which is a silent no-op from
   * the user's side.
   *
   * @param key - reference key.
   * @param translator - `{chunks, translate}` runner.
   * @param patch - spec fields to commit before running (`{lang, mode, sourceLang}`).
   */
  retry(key, translator, patch = {}) {
    this.#abortOne(key)
    this.#patch(key, { status: 'pending', translation: '', error: null, cached: false, ...patch })
    this.#run(key, translator)
  }

  /** Cancel one in-flight reference. */
  cancel(key) {
    this.#abortOne(key)
    this.#patch(key, { status: 'cancelled' })
  }

  /** Remove one reference and forget its cached result. */
  remove(key) {
    this.#abortOne(key)
    const victim = this.find(key)
    if (victim !== undefined) this.#cache.delete(answerKeyOf(victim, victim.text))
    const refs = this.list().filter((ref) => ref.key !== key)
    this.commit({ refs, active: refs[0]?.key ?? null })
    this.#persist()
  }

  /** Remove every reference of this session. */
  clear() {
    this.#abortAll()
    this.#cache.clear()
    this.commit({ refs: [], active: null })
    removeKey(`${REFS_PREFIX}${this.#sessionKey}`)
  }

  /**
   * Kick off the request(s) for one reference: chunked, serial, appended in order.
   * A failure marks the card but keeps whatever arrived, so a partial answer stays
   * readable and the user can retry just that card.
   */
  async #run(key, translator) {
    const ref = this.find(key)
    if (ref === undefined) return
    // A reference that already carries an answer (a cache hit, or a card restored
    // from localStorage) costs nothing: re-running it would throw away a finished
    // translation and clear its `cached` marker for a fresh request.
    if (ref.status === 'done' && typeof ref.translation === 'string' && ref.translation !== '') return

    const controller = new AbortController()
    this.#controllers.set(key, controller)
    this.#patch(key, { status: 'streaming' })

    // Finished pieces, plus the unit still streaming: a failure in the middle of a
    // chunk must not lose what that chunk already delivered, so the partial text is
    // tracked separately from the completed list.
    const pieces = []
    let current = ''
    const visibleText = () => [...pieces, current].filter((piece) => piece !== '').join('\n\n')
    try {
      const units = translator.chunks(ref.text)
      for (const unit of units) {
        if (controller.signal.aborted) return
        current = ''
        await translator.translate({
          text: unit,
          kind: ref.kind,
          lang: ref.lang,
          mode: ref.mode ?? LEGACY_MODE,
          sourceLang: ref.sourceLang ?? LEGACY_SOURCE,
          signal: controller.signal,
          onStart: (info) => {
            this.#patch(key, { routeLabel: info.label })
          },
          onDelta: (delta) => {
            current += delta
            this.#patch(key, { translation: visibleText(), status: 'streaming' })
          },
        })
        pieces.push(current)
        current = ''
      }
      if (controller.signal.aborted) return
      // Chunks are joined BETWEEN each other only: appending after the last one
      // left a trailing blank line in every multi-chunk answer.
      const accumulated = pieces.filter((piece) => piece !== '').join('\n\n')
      this.#cache.set(answerKeyOf(ref, ref.text), accumulated.trim())
      while (this.#cache.size > MAX_CACHE) {
        const oldest = this.#cache.keys().next()
        if (oldest.done === true) break
        this.#cache.delete(oldest.value)
      }
      // A reference seeded from the in-page cache keeps its marker instead of
      // reporting a fresh model call that never happened.
      this.#patch(key, { translation: accumulated, status: 'done', error: null, cached: ref.cached === true })
    } catch (error) {
      if (controller.signal.aborted) {
        this.#patch(key, { status: 'cancelled' })
        return
      }
      this.#patch(key, {
        status: 'error',
        translation: visibleText(),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (this.#controllers.get(key) === controller) this.#controllers.delete(key)
      this.#persist()
    }
  }

  /** Move one reference to the head of the list. */
  #raise(key) {
    const refs = this.list()
    const hit = refs.find((ref) => ref.key === key)
    if (hit === undefined) return
    const next = [{ ...hit, at: Date.now() }, ...refs.filter((ref) => ref.key !== key)]
    this.commit({ refs: next, active: key })
    this.#persist()
  }

  /** Commit one reference's changed fields; returns a fresh list. */
  #patch(key, patch) {
    const refs = this.list().map((ref) => (ref.key === key ? { ...ref, ...patch } : ref))
    this.commit({ ...this.getSnapshot(), refs })
  }

  /** Persist the current list (done/error cards only — partials survive too). */
  #persist() {
    writeJson(`${REFS_PREFIX}${this.#sessionKey}`, { refs: this.list() })
  }

  /** Abort and forget one controller. */
  #abortOne(key) {
    const controller = this.#controllers.get(key)
    if (controller === undefined) return
    controller.abort()
    this.#controllers.delete(key)
  }

  /** Abort every live controller. */
  #abortAll() {
    for (const controller of this.#controllers.values()) controller.abort()
    this.#controllers.clear()
  }
}

/** Whether a persisted entry still has the shape the UI expects. */
function isStoredRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.key === 'string' &&
    typeof value.text === 'string' &&
    typeof value.lang === 'string'
  )
}

/**
 * Fill the fields a card written before beta.2 cannot have.
 *
 * The alternative — defaulting on every read — means a card whose gear is
 * `undefined` in one code path and `'general'` in another, and the spec
 * comparison that decides whether to re-translate uses exactly those fields.
 * @param ref - one persisted reference.
 * @returns the same reference with `mode` and `sourceLang` present.
 */
function normalizeStoredRef(ref) {
  return { ...ref, mode: ref.mode ?? LEGACY_MODE, sourceLang: ref.sourceLang ?? LEGACY_SOURCE }
}
