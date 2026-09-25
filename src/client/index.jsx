/**
 * dsh-translator — browser half.
 *
 * Wires four things together:
 * 1. a document-level selection watcher that offers a floating 「译」 button for
 *    any English selection inside the conversation;
 * 2. a per-session reference store (`RefsStore`) that owns the cards, the
 *    in-page result cache, and the streaming lifecycle;
 * 3. a right-sidebar tab type (`翻译`) registered through the two-stage API, so
 *    the pane docks, floats, and composes with the other sidebar plugins;
 * 4. a Settings → General row plus the `Ctrl+Shift+T` shortcut.
 *
 * The browser half never touches the session log: translations live in this
 * store, in localStorage, and in the host's LRU — never in the model's context.
 *
 * There are no React hooks in `apply`: a plugin body is a plain function, so the
 * two portal roots (the trigger and the fallback card) render from module-level
 * observable state that `apply` mutates.
 *
 * @module dsh-translator/client
 */

import React from 'react'
import { createRoot } from 'react-dom/client'

import {
  DEFAULT_MODE_ID,
  DEFAULT_TARGET_CODE,
  SOURCE_AUTO,
  chunkText,
  classifySelection,
  detectLanguage,
  effectiveSource,
  isKnownMode,
  languageLabel,
  languageVerdict,
  maskCode,
  nextPairAfterSource,
  nextPairAfterTarget,
  normalizeSelection,
  restoreCode,
  swapPair,
} from '../shared/select.js'
import { provenanceFor, readChatSnapshot } from './chat.js'
import { FloatCard } from './FloatCard.jsx'
import { translate } from './query.js'
import { SelectionTrigger, pillAnchorFor } from './SelectionTrigger.jsx'
import { SettingsRow } from './SettingsRow.jsx'
import { RefsStore, LEGACY_MODE, LEGACY_SOURCE, SettingsStore } from './stores.js'
import { installStyles } from './styles.js'
import { TranslatePane, TranslateTitle, installErrorCapture, renderFailureLog } from './TranslatePane.jsx'
import { watchSelection } from './watch.js'

/**
 * Re-exported so the seat components can be driven directly (with a controlled
 * store) by the test harness: the slot hosts close over the plugin's own store.
 */
export const TranslatePaneExport = TranslatePane
/** @see TranslatePaneExport */
export const TranslateTitleExport = TranslateTitle
/** @see TranslatePaneExport — the floating pill is driven directly as well. */
export const SelectionTriggerExport = SelectionTrigger
/** @see TranslatePaneExport — the pill's placement maths. */
export const pillAnchorForExport = pillAnchorFor
/** @see TranslatePaneExport — the SSE transport, driven directly by the probe/tests. */
export const translateExport = translate
/** @see TranslatePaneExport — the `?dsht-debug=1` report panel. */
export const DebugReportExport = DebugReport
/** @see TranslatePaneExport — read back by the self-report and by the tests. */
export const renderFailureLogExport = renderFailureLog

/**
 * Hard service prerequisites: NONE, and that is a deliberate contract.
 *
 * dsh's WEB boot walks every client loader entry and THROWS if any of them is not
 * `active`:
 *
 *     if (o.length > 0) throw new Error(`web boot: ${o.length} entries did not activate …`)
 *
 * with `pending (waiting for service: X)` counted as not active. One plugin
 * declaring one service that a DSH upgrade renamed therefore does not degrade
 * that plugin — it kills the entire Web GUI at the boot screen. That is exactly
 * what DSH 0.1.7-rc.2 did to this plugin: it deleted the client-side
 * `settingsScope` service, this package listed it in `inject`, and the whole app
 * stopped mounting (see README §「已知坑与排查」0).
 *
 * So every service is taken through a `ctx.inject([...], cb)` CHILD fiber below.
 * A child fiber is not a loader entry, so a service that disappears leaves that
 * one capability parked and everything else — including the rest of dsh —
 * working. The price is that `apply` must tolerate every service being absent,
 * which is why it reads them through `ctx.get(name)` and gates each block.
 */
export const inject = []

/** Services the sidebar seats need; absence downgrades the plugin, not the app. */
export const SIDEBAR_SERVICES = ['slots', 'sidebarRight', 'sidebarRightTabs']

/** Services the Settings → General row needs. */
export const SETTINGS_SERVICES = ['slots']

/** The tab body seat: one component per tab type, keyed by the definition id. */
const BODY_SLOT = 'sidebar.right.pane.tab'
/** The tab chip/header seat, same key. */
const TITLE_SLOT = 'sidebar.right.pane.tab.title'
/** One preference row inside Settings → General. */
const SETTINGS_SLOT = 'settings.general.item'

/**
 * Every slot this plugin contributes to.
 *
 * Exported so `tools/check-dsh-compat.mjs` can verify — against the DSH actually
 * installed — that each name still exists, instead of letting the next `dsh`
 * upgrade discover it the hard way.
 */
export const SLOT_SEATS = [BODY_SLOT, TITLE_SLOT, SETTINGS_SLOT]

/**
 * The service that owns the current-Session binding.
 *
 * `ui-session` installs itself as the renderer-facing scope adapter for the
 * `session` scope. Its `adapter.current` binding carries `key: binding.sessionId`
 * — the Session on screen — and `key: undefined` while nothing is selected.
 */
export const SESSION_SCOPE_SERVICE = 'uiSession'

/**
 * Tab type discrimination: what `openTab()` names. The seats are NOT keyed on this
 * — see {@link TAB_ID}.
 */
const KIND = 'translator'

/**
 * The tab type's identity AND the key both seats register under.
 *
 * ui-sidebar-right dispatches `sidebar.right.pane.tab` with
 * `entryKey: definition?.id ?? tab.kind`, so this package name is what the body and
 * title lookups use. Registering the seats under {@link KIND} silently resolves
 * nothing and the column shows its own "no viewer" notice instead of the pane.
 */
const TAB_ID = 'dsh-translator'

/**
 * Stamp of the client bundle the PAGE is running.
 *
 * The browser fetches a plugin bundle when the page loads, so a rebuild is only
 * live after a refresh. Without a stamp, a stale tab and a genuine bug look
 * identical from the outside; the `?dsht-debug=1` report prints this line so the
 * two can be told apart in one screenshot.
 */
const BUNDLE_STAMP = 'client-2026-09-26T03:20Z-dsh017-pair-modes-beta2'

/** Tab title. */
const TAB_TITLE = '翻译'

/** The most recent selection, so the shortcut can act on it after a click cleared it. */
let lastSelection = null

/** Parse a shortcut spec (`Ctrl+Shift+T`, `Alt+J`, …). */
export function parseShortcut(spec) {
  const parts = String(spec ?? '')
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
  if (parts.length === 0) return null
  const key = parts[parts.length - 1]
  return {
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    key,
  }
}

/** Whether a keyboard event matches a parsed shortcut. */
export function matchesShortcut(event, shortcut) {
  if (shortcut === null || shortcut === undefined) return false
  if (String(event.key ?? '').toLowerCase() !== shortcut.key) return false
  return event.ctrlKey === shortcut.ctrl && event.altKey === shortcut.alt && event.shiftKey === shortcut.shift
}

/** Read one service without declaring a dependency on it, or undefined. */
export function serviceOf(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * The Session the page is currently displaying, or undefined.
 *
 * DSH 0.1.7 removed `current` from the Session Controller's list snapshot — that
 * snapshot is catalog membership only now (`ids` / `byId` / `phase`), because
 * "which Session is on screen" moved to the view owners. The public source of that
 * fact is the renderer-facing scope adapter: `uiSession.adapter.current` is a
 * `StandardSourceBinding` whose `key` IS the Session id.
 *
 * @param ctx - client context.
 * @returns the Session id, or undefined when nothing is selected (or unavailable).
 */
export function scopeSessionKey(ctx) {
  const binding = scopeBinding(ctx)
  const key = binding?.key
  return typeof key === 'string' && key !== '' ? key : undefined
}

/**
 * The raw current scope binding, or undefined when the service is not there.
 * @param ctx - client context.
 * @returns the binding snapshot.
 */
export function scopeBinding(ctx) {
  try {
    const current = serviceOf(ctx, SESSION_SCOPE_SERVICE)?.adapter?.current
    return typeof current?.getSnapshot === 'function' ? current.getSnapshot() : undefined
  } catch {
    return undefined
  }
}

/**
 * The storage namespace for this plugin's reference list.
 *
 * Store namespaces are local to the browser (one localStorage key per Session), so
 * an unresolvable Session degrades to a shared bucket rather than to lost cards.
 *
 * @param ctx - client context.
 * @returns a Session id, or `'default'`.
 */
export function sessionKeyOf(ctx) {
  return scopeSessionKey(ctx) ?? 'default'
}

/**
 * Decide what the pane's bottom composer does with what the user typed.
 *
 * The composer is NOT the selection trigger, and the difference is the point: a
 * selection has to clear a length floor (`MIN_SELECTION_CHARS`) because a stray
 * click produces stray selections, whereas text someone deliberately typed is an
 * instruction. So the floor is dropped here and only two things are refused — an
 * empty box, and text that already IS the target language (which is now decided
 * by the shared language verdict, so it follows the configured pair: with the
 * target on English, English input is the pointless one, not Chinese).
 *
 * Pure and exported so the rule can be asserted directly instead of through a
 * synthetic event.
 *
 * @param raw - the composer's current text.
 * @param policy - `{source, target}`; the language pair in force.
 * @returns `{action: 'blank'|'same-language'|'translate', text}`.
 */
export function classifyManualInput(raw, policy = {}) {
  const text = normalizeSelection(raw)
  if (text === '') return { action: 'blank', text }
  const verdict = languageVerdict(text, policy)
  if (verdict.same) return { action: 'same-language', text, reason: 'same-language', detected: verdict.detected }
  return { action: 'translate', text, reason: 'ok', detected: verdict.detected }
}

/** Whether this page asked for the plugin's self-report (`?dsht-debug=1`). */
export function debugRequested() {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('dsht-debug') === '1'
  } catch {
    return false
  }
}

/**
 * Report the plugin's own wiring on screen and in the console.
 *
 * Written for the case where a screenshot is the only channel available: the
 * sidebar pane could be blank for reasons that live entirely in the browser
 * (services missing, store empty, styles not applied, a render throw), and none of
 * them are visible from the host. Every line here is something a maintainer would
 * otherwise have to ask the user to dig out of devtools.
 *
 * @param lines - the report.
 * @returns the panel element, or null outside a document.
 */
export function DebugReport({ lines }) {
  if (typeof document === 'undefined') return null
  return (
    <div
      data-dsh-translator-ui="1"
      data-dsh-translator-debug="1"
      style={{
        position: 'fixed',
        left: '12px',
        bottom: '12px',
        zIndex: '2147483001',
        maxWidth: 'min(560px, 80vw)',
        maxHeight: '50vh',
        overflow: 'auto',
        padding: '10px 12px',
        borderRadius: '10px',
        border: '1px solid #679efe',
        background: '#12161f',
        color: '#e6ebf2',
        font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap',
        boxShadow: '0 8px 28px rgba(0,0,0,.5)',
      }}
    >
      <div style={{ fontWeight: 700, color: '#679efe', marginBottom: '6px' }}>dsh-translator 自检</div>
      {lines.map((line, index) => (
        <div key={String(index)}>{line}</div>
      ))}
    </div>
  )
}

/** Apply the browser half. */
export function apply(ctx) {
  installStyles()
  installErrorCapture()

  const settings = new SettingsStore()
  const store = new RefsStore(sessionKeyOf(ctx))

  // Portal roots render from these: `apply` has no hooks, so the two React trees
  // are driven by an explicit re-render call instead.
  const roots = new Map()
  const rerender = () => {
    for (const render of roots.values()) render()
  }

  let fallbackOpen = false
  let fallbackReason = ''
  /** Where the current namespace came from, for the self-report. */
  let sessionSource = scopeSessionKey(ctx) === undefined ? 'default' : SESSION_SCOPE_SERVICE
  /** Seat keys recorded at registration time, so the self-report can prove them. */
  const seatKeys = { type: '', body: '(not registered)', title: '(not registered)' }

  /** Switch the store's namespace and remember which source decided it. */
  const useSession = (key, source) => {
    if (typeof key !== 'string' || key === '') return
    sessionSource = source
    store.setSession(key)
  }

  /** Record why the floating card is standing in for the sidebar. */
  const useFallback = (cause) => {
    fallbackOpen = true
    fallbackReason = cause instanceof Error ? cause.message : String(cause)
    rerender()
  }

  /** Open the sidebar pane when that column exists; otherwise reveal the card. */
  const openPane = () => {
    try {
      const sidebar = serviceOf(ctx, 'sidebarRight')
      if (sidebar === undefined || typeof sidebar.openTab !== 'function') {
        throw new Error('右侧边栏服务不可用（未安装 dsh-client-ui-sidebar-right？）')
      }
      sidebar.openTab(KIND)
      return true
    } catch (cause) {
      // Never fail silently: a click that produced nothing visible is exactly the
      // bug worth preventing, so the fallback card says why it appeared.
      console.warn('[dsh-translator] 右侧边栏不可用，改用浮层卡片:', cause)
      useFallback(cause)
      return false
    }
  }

  /** The language pair in force, read fresh — the settings are live. */
  const pair = () => ({
    source: settings.getSnapshot().sourceLanguage ?? SOURCE_AUTO,
    target: settings.getSnapshot().targetLanguage ?? DEFAULT_TARGET_CODE,
  })

  /** The gear in force. */
  const mode = () => settings.getSnapshot().mode ?? DEFAULT_MODE_ID

  /** The text behind the `custom` gear. */
  const instruction = () => settings.getSnapshot().customInstruction ?? ''

  /** The policy every classification decision is made under. */
  const policy = () => ({ source: pair().source, target: pair().target })

  /** The spec stored on one card, with the pre-beta.2 defaults filled in. */
  const specOf = (ref) => ({
    lang: ref?.lang ?? DEFAULT_TARGET_CODE,
    mode: ref?.mode ?? LEGACY_MODE,
    sourceLang: ref?.sourceLang ?? LEGACY_SOURCE,
  })

  /**
   * The most recent recognisable source language.
   *
   * Read from the newest card rather than remembered: the swap button needs
   * "the language the user was just reading", and a variable would go stale the
   * moment a card is deleted or restored from storage.
   * @returns a detected code, or null.
   */
  const detectedNow = () => {
    for (const ref of store.list()) {
      const verdict = detectLanguage(ref.text)
      if (verdict.certain) return verdict.code
    }
    return null
  }

  /**
   * Re-run every card whose spec no longer matches the settings.
   *
   * Cards are NOT duplicated and NOT left alone: a gear or language change is a
   * request to see the same texts under the new pair/gear, and because the page
   * cache and the host cache are both keyed by (target, gear, source) the way
   * back is a cache hit. A card that is already correct is skipped, so a
   * no-op change costs nothing.
   *
   * A card whose TEXT is already the new target language is skipped too, and that
   * is the interesting rule: the swap button exists for the next thing you type,
   * so without it an English card would be re-run into English — a paid call to
   * get the same sentence back. The card keeps its own pair, and its chip says so.
   *
   * The test is the DETECTED language of the card's text, deliberately not the
   * declared source: a swap pins the source to the old target, so a card whose
   * text is English would otherwise be "translated" from Chinese into English.
   *
   * @param patch - `{lang?, mode?, sourceLang?}` to commit before re-running.
   */
  const retranslateAll = (patch) => {
    for (const ref of store.list()) {
      const current = specOf(ref)
      const want = { ...current, ...patch }
      if (want.lang === current.lang && want.mode === current.mode && want.sourceLang === current.sourceLang) continue
      const detected = detectLanguage(ref.text)
      if (detected.certain && detected.code === want.lang) continue
      store.retry(ref.key, translatorFor(ref.text, ref.kind), want)
    }
  }

  /** Build the translator face for one reference: chunking, masking, SSE. */
  function translatorFor(text, kind) {
    return {
      chunks: (value) => chunkText(value),
      translate: async ({ text: unit, kind: unitKind, lang, mode: unitMode, sourceLang, signal, onStart, onDelta }) => {
        const masking = (settings.getSnapshot().maskCode ?? true) ? maskCode(unit) : { text: unit, spans: [] }
        if (masking.text.trim() === '') {
          // The whole unit is code: keep the original untouched.
          onDelta?.(unit)
          return unit
        }
        // Detected here, on exactly the text the host will receive and key its
        // cache on, so the hint in the prompt and the cache key can never tell
        // two different stories about the same request.
        const gear = unitMode ?? mode()
        let whole = ''
        await translate({
          text: masking.text,
          kind: unitKind ?? kind,
          lang,
          source: effectiveSource(masking.text, sourceLang),
          mode: gear,
          instruction: gear === 'custom' ? instruction() : '',
          signal,
          onStart,
          onDelta: (delta) => {
            whole += delta
            onDelta?.(delta)
          },
        })
        const restored = restoreCode(whole, masking.spans)
        if (restored.length > whole.length) onDelta?.(restored.slice(whole.length))
        return restored
      },
    }
  }

  const runtime = {
    addRef: (text, meta = {}) => {
      const live = policy()
      const classified = classifySelection(text, live)
      // `noop` is refused as well as `ignore`: before, an already-Chinese
      // selection that reached this path (the keyboard shortcut, a drag) was
      // translated Chinese → Chinese, which is a paid no-op.
      if (classified.action === 'ignore') {
        console.warn('[dsh-translator] 选中的内容无需翻译（过短或为空），未创建引用')
        return null
      }
      if (classified.action === 'noop') {
        console.warn(`[dsh-translator] 选中的内容已经是目标语言（${languageLabel(live.target)}），未创建引用`)
        return null
      }
      // Provenance is decoration: `uiConversation` is read, not declared, so a
      // renamed service costs the card its turn/step label and nothing else.
      const snapshot = readChatSnapshot(serviceOf(ctx, 'uiConversation'), store.sessionKey())
      const label = meta.sourceLabel ?? provenanceFor(snapshot, classified.text)
      return store.add(
        {
          text: classified.text,
          kind: meta.kind ?? 'selection',
          lang: live.target,
          mode: mode(),
          sourceLang: live.source,
          sourceLabel: label,
        },
        translatorFor(classified.text, meta.kind ?? 'selection'),
      )
    },
    retry: (key) => {
      const ref = store.find(key)
      store.retry(key, translatorFor(ref?.text ?? '', ref?.kind ?? 'selection'))
    },
    /**
     * Commit text typed into the pane's bottom composer as one more reference.
     *
     * Same destination as a selection (the shared `RefsStore` and the existing
     * translate pipeline), different gate — see {@link classifyManualInput}. It
     * returns a result object instead of a key because the composer has to tell the
     * user WHY nothing happened; a silent no-op on Enter reads as a broken box.
     *
     * @param raw - the composer's text.
     * @returns `{ok: true, key, text}` or `{ok: false, reason}`.
     */
    addManual: (raw) => {
      const live = policy()
      const classified = classifyManualInput(raw, live)
      if (classified.action === 'blank') return { ok: false, reason: 'blank' }
      if (classified.action === 'same-language') return { ok: false, reason: 'same-language', target: live.target }
      const key = store.add(
        {
          text: classified.text,
          kind: 'selection',
          lang: live.target,
          mode: mode(),
          sourceLang: live.source,
          sourceLabel: '手动输入',
        },
        translatorFor(classified.text, 'selection'),
      )
      return { ok: true, key, text: classified.text }
    },
    cancel: (key) => store.cancel(key),
    remove: (key) => store.remove(key),
    clear: () => store.clear(),
    /**
     * Pick a source language. A pick that collides with the target moves the
     * TARGET out of the way rather than deadlocking the pair (see
     * `nextPairAfterSource`).
     */
    setSourceLanguage: (code) => {
      const next = nextPairAfterSource(pair(), code, detectedNow())
      settings.update({ sourceLanguage: next.source, targetLanguage: next.target })
      retranslateAll({ sourceLang: next.source, lang: next.target })
    },
    /** Pick a target language; mirrors {@link runtime.setSourceLanguage}. */
    setTargetLanguage: (code) => {
      const next = nextPairAfterTarget(pair(), code, detectedNow())
      settings.update({ sourceLanguage: next.source, targetLanguage: next.target })
      retranslateAll({ sourceLang: next.source, lang: next.target })
    },
    /** Pick a translation gear and re-run the cards under it. */
    setMode: (id) => {
      const chosen = isKnownMode(id) ? id : DEFAULT_MODE_ID
      settings.update({ mode: chosen })
      retranslateAll({ mode: chosen })
    },
    /** Exchange the two sides (or pin the source and aim at what was detected). */
    swapLanguages: () => {
      const next = swapPair(pair(), detectedNow())
      settings.update({ sourceLanguage: next.source, targetLanguage: next.target })
      retranslateAll({ sourceLang: next.source, lang: next.target })
    },
    get sourceLanguage() {
      return pair().source
    },
    get targetLanguage() {
      return pair().target
    },
    get mode() {
      return mode()
    },
    get customInstruction() {
      return instruction()
    },
    /** The most recent recognisable source language (for the swap button). */
    get detected() {
      return detectedNow()
    },
    get shortcut() {
      return settings.getSnapshot().shortcut ?? ''
    },
  }

  /** The single entry point every trigger path funnels into. */
  const commitSelection = (text, meta) => {
    if (text === null || text === undefined || String(text).trim() === '') {
      openPane()
      return
    }
    // `addRef` returns null when the text is not worth translating (too short,
    // blank, or already the target language) and says which on the console, so a
    // click with no visible effect still leaves a trail.
    const key = runtime.addRef(text, meta ?? { kind: 'selection', sourceLabel: '划选内容' })
    if (key === null) return
    openPane()
  }

  // --- Selection watcher + trigger root ------------------------------------
  // Neither needs a service: these run even when the sidebar half is absent, which
  // is what keeps the plugin useful in a composition without a right column.
  ctx.effect(() => {
    const teardown = watchSelection(
      (next) => {
        lastSelection = next
        rerender()
      },
      // The pill's own verdict ("已经是目标语言了") has to follow the live pair:
      // with the target on Japanese, a Japanese selection is the pointless one.
      () => policy(),
    )
    return teardown
  }, 'dsh-translator: selection watcher')

  ctx.effect(
    () =>
      registerRoot(roots, 'trigger', () =>
        React.createElement(SelectionTrigger, {
          candidate: lastSelection,
          onCommit: (text, meta) => commitSelection(text, meta),
          onDismiss: () => {
            lastSelection = null
            rerender()
          },
        }),
      ),
    'dsh-translator: selection trigger root',
  )

  // --- Fallback card root (used only when the sidebar is absent) -----------
  ctx.effect(
    () =>
      registerRoot(roots, 'float', () =>
        fallbackOpen
          ? React.createElement(FloatCard, {
              store,
              runtime,
              reason: fallbackReason,
              onClose: () => {
                fallbackOpen = false
                rerender()
              },
            })
          : null,
      ),
    'dsh-translator: fallback card root',
  )

  // --- Keyboard shortcut ---------------------------------------------------
  ctx.effect(() => {
    const onKeyDown = (event) => {
      if (!matchesShortcut(event, parseShortcut(settings.getSnapshot().shortcut))) return
      const live = globalThis.getSelection?.()?.toString?.() ?? ''
      const text = live.trim() !== '' ? live : lastSelection?.text ?? ''
      event.preventDefault()
      event.stopPropagation()
      commitSelection(text, { kind: 'selection', sourceLabel: '快捷键引用' })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, 'dsh-translator: translate shortcut')

  // --- Session namespace (soft: `uiSession`) -------------------------------
  // One localStorage list per Session, so switching Sessions shows that Session's
  // own references instead of a shared pile. If this service ever goes away the
  // store simply stays on `default` — and the pane's own `sessionId` prop (below)
  // re-scopes it as soon as the pane is on screen.
  ctx.inject([SESSION_SCOPE_SERVICE], (scopeCtx) => {
    scopeCtx.effect(() => {
      const source = scopeCtx?.uiSession?.adapter?.current
      if (source === undefined || typeof source.getSnapshot !== 'function') {
        return () => {}
      }
      const sync = () => useSession(source.getSnapshot()?.key, SESSION_SCOPE_SERVICE)
      sync()
      const unsubscribe = source.subscribe?.(sync)
      return () => unsubscribe?.()
    }, 'dsh-translator: session scope')
  }, 'dsh-translator: session namespace')

  // --- Sidebar tab type + seats (soft) -------------------------------------
  // This is the block that used to be a top-level `inject`, i.e. the block whose
  // missing service used to take the whole Web GUI down with it.
  ctx.inject(SIDEBAR_SERVICES, (sidebarCtx) => {
    sidebarCtx.effect(() => {
      // The seats are dispatched with `definition.id ?? tab.kind` (see
      // `TabSlot` in ui-sidebar-right), so the BODY and TITLE registrations must key
      // on the definition id — not on the kind. Keying on the kind leaves both seats
      // unresolved and the pane renders the column's own fallback notice
      // ("这类内容还没有可用的查看方式。"), which is exactly how this broke once.
      let disposeType
      let disposeBody
      let disposeTitle
      try {
        disposeType = sidebarCtx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          title: () => TAB_TITLE,
          // `guide[].id` became REQUIRED in 0.1.7: ui-sidebar-right rejects a
          // provider whose entries collide on `id`, and an absent id collides with
          // every other absent one.
          guide: [
            {
              id: TAB_ID,
              order: 40,
              title: () => TAB_TITLE,
              description: () => '划选对话里的英文，在这里看实时中文译文',
            },
          ],
        })
        // Both seats stay PLAIN components — no wrapper. A wrapper that calls its
        // children as plain functions during render would run TranslatePane's hooks
        // under the wrapper's identity, which is exactly the rules-of-hooks violation
        // that can blank the whole subtree in a real React. Failure visibility is
        // handled inside the pane instead (see TranslatePane's own guard).
        //
        // `sidebar.right.pane.tab` is a `session`-scoped keyed slot, so the renderer
        // hands the body a flat `sessionId` prop: that is the authoritative Session
        // for the pane the user is looking at, and it re-scopes the store even when
        // the scope service above is unavailable.
        const PaneHost = (props) => {
          const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
          return sessionId === undefined
            ? React.createElement(TranslatePane, { store, runtime })
            : React.createElement(TranslatePane, { store, runtime, sessionKey: sessionId })
        }
        const TitleHost = () => React.createElement(TranslateTitle, { store, title: TAB_TITLE })
        seatKeys.type = TAB_ID
        seatKeys.body = TAB_ID
        seatKeys.title = TAB_ID
        disposeBody = sidebarCtx.slots.inject(BODY_SLOT, () =>
          sidebarCtx.slots.register({ name: BODY_SLOT, key: TAB_ID }, PaneHost),
        )
        disposeTitle = sidebarCtx.slots.inject(TITLE_SLOT, () =>
          sidebarCtx.slots.register({ name: TITLE_SLOT, key: TAB_ID }, TitleHost),
        )
      } catch (cause) {
        // A sidebar we cannot seat is a degraded plugin, never a broken one: this
        // used to throw out of `apply`, which at boot means no Web GUI at all.
        console.warn('[dsh-translator] 右侧边栏页签注册失败，改用浮层卡片:', cause)
        try {
          disposeTitle?.()
        } catch {
          /* nothing to undo */
        }
        try {
          disposeBody?.()
        } catch {
          /* nothing to undo */
        }
        try {
          disposeType?.()
        } catch {
          /* nothing to undo */
        }
        seatKeys.type = `失败: ${cause instanceof Error ? cause.message : String(cause)}`
        seatKeys.body = '(not registered)'
        seatKeys.title = '(not registered)'
        useFallback(cause)
        return () => {}
      }
      return () => {
        disposeTitle()
        disposeBody()
        disposeType()
      }
    }, 'dsh-translator: sidebar tab type')
  }, 'dsh-translator: sidebar tab type + seats')

  // --- Settings → General row (soft) ---------------------------------------
  ctx.inject(SETTINGS_SERVICES, (slotCtx) => {
    slotCtx.effect(() => {
      const SettingsHost = () => React.createElement(SettingsRow, { store: settings })
      try {
        return slotCtx.slots.inject(SETTINGS_SLOT, () =>
          slotCtx.slots.register({ name: SETTINGS_SLOT, id: 'translator', order: 60 }, SettingsHost),
        )
      } catch (cause) {
        console.warn('[dsh-translator] 设置项注册失败:', cause)
        return () => {}
      }
    }, 'dsh-translator: settings row')
  }, 'dsh-translator: settings row seat')

  // --- Self-report (`?dsht-debug=1`) ---------------------------------------
  ctx.effect(() => {
    if (!debugRequested()) return () => {}
    const errors = renderFailureLog()
    const slots = serviceOf(ctx, 'slots')
    const sidebarRight = serviceOf(ctx, 'sidebarRight')
    const tabs = serviceOf(ctx, 'sidebarRightTabs')
    const lines = [
      `plugin        : dsh-translator (client)`,
      `bundle        : ${BUNDLE_STAMP}（与 lib/client.js 的构建时间对照；不一致=页面跑的是旧产物，需要刷新）`,
      `styles tag    : ${typeof document !== 'undefined' && document.getElementById('dsh-translator-style') !== null}`,
      `services      : slots=${typeof slots?.register === 'function'} sidebarRight=${typeof sidebarRight?.openTab === 'function'} tabs=${typeof tabs?.register === 'function'} uiSession=${serviceOf(ctx, SESSION_SCOPE_SERVICE) !== undefined}`,
      `hard deps     : ${inject.length === 0 ? '无（全部走 ctx.inject 子 fiber，缺服务只降级不阻塞启动）' : inject.join(', ')}`,
      `tab id / kind : ${TAB_ID} / ${KIND}`,
      `seat keys     : body=${seatKeys.body} title=${seatKeys.title}`,
      `session       : ${store.sessionKey()}（来源: ${sessionSource}）`,
      `pair / gear   : ${pair().source === SOURCE_AUTO ? '自动检测' : languageLabel(pair().source)} → ${languageLabel(pair().target)} · ${runtime.mode}`,
      `detected last : ${detectedNow() ?? '（无）'}`,
      `refs          : ${store.list().length}（${store.list().map((ref) => `${ref.status}:${[...(ref.translation ?? '')].length}字:${ref.mode ?? LEGACY_MODE}`).join(', ') || '空'}）`,
      `slots.snapshot: ${describeSlot(slots, 'sidebar.right.pane.tab')}`,
      `slot.title    : ${describeSlot(slots, 'sidebar.right.pane.tab.title')}`,
      `tab types     : ${describeTabTypes(tabs)}`,
      `openTab       : ${(() => {
        try {
          if (typeof sidebarRight?.openTab !== 'function') return 'SKIPPED（sidebarRight 不可用）'
          sidebarRight.openTab(KIND)
          return 'ok'
        } catch (error) {
          return `THREW ${error instanceof Error ? error.message : String(error)}`
        }
      })()}`,
      `pane render   : ${(() => {
        try {
          const tree = TranslatePane({ store, runtime })
          return tree === null ? 'null' : `ok <${tree.type?.name ?? tree.type}>`
        } catch (error) {
          return `THREW ${renderFailureLog()[0] ?? String(error)}`
        }
      })()}`,
      `render errors : ${errors.length === 0 ? '（无）' : errors.join(' | ')}`,
      `hint          : 空白面板 = 座位条目"退位"（组件渲染抛错）；兜底文案 = 座位 key 不匹配`,
    ]
    for (const line of lines) console.log('[dsh-translator] 自检 |', line)
    return registerRoot(roots, 'debug', () => React.createElement(DebugReport, { lines }))
  }, 'dsh-translator: debug report')
}

/**
 * Describe one slot's occupants through the runtime's own diagnostic API.
 *
 * The shape changed in 0.1.7: `slots.snapshot(root?)` used to answer with ONE
 * node carrying `declaredBy` / `occupants`; it is now an ARRAY of live
 * composition nodes (`LiveCompositionNode[]`), and the node whose `name` matches
 * is the one to read. Reporting the old shape produced a permanent
 * `declaredBy=? occupants=[无]` line — a debug surface that lies is worse than
 * none.
 *
 * @param slots - the slot registry, or undefined when the service is absent.
 * @param slot - slot name.
 * @returns a one-line summary.
 */
export function describeSlot(slots, slot) {
  try {
    if (slots === undefined || typeof slots.snapshot !== 'function') return '（无快照 API）'
    const tree = slots.snapshot(slot)
    const nodes = Array.isArray(tree) ? tree : [tree]
    const node = nodes.find((candidate) => candidate?.name === slot) ?? nodes.find((candidate) => candidate?.type === 'slot')
    if (node === undefined) return '（该槽位未声明）'
    const occupants = Array.isArray(node.occupants) ? node.occupants : []
    const described = occupants.map(
      (entry) => `${entry.key ?? entry.id ?? '?'}${entry.active === false ? '(inactive)' : ''}`,
    )
    return `declaredBy=${node.declaredBy ?? '?'} occupants=[${described.join(', ') || '无'}]`
  } catch (error) {
    return `THREW ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Describe the registered tab types (id/kind pairs), which is what the seat key is
 * derived from.
 * @param tabs - the tab-type registry, or undefined when the service is absent.
 * @returns a one-line summary.
 */
export function describeTabTypes(tabs) {
  try {
    const entries = tabs?.entries?.()
    if (!Array.isArray(entries)) return '（无 entries API）'
    return entries.map((entry) => `${entry.id}/${entry.kind}`).join(', ') || '（空）'
  } catch (error) {
    return `THREW ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Mount one React portal root and keep it addressable for re-renders.
 * @param roots - id → render map owned by `apply`.
 * @param id - root id.
 * @param render - returns the element tree (or null).
 * @returns teardown function.
 */
function registerRoot(roots, id, render) {
  if (typeof document === 'undefined') return () => {}
  const container = document.createElement('div')
  container.dataset.dshTranslatorUi = '1'
  container.style.display = 'contents'
  document.body.appendChild(container)
  const root = createRoot(container)
  const draw = () => {
    try {
      root.render(render())
    } catch (cause) {
      console.error('[dsh-translator] 渲染失败:', cause)
    }
  }
  roots.set(id, draw)
  draw()
  return () => {
    roots.delete(id)
    try {
      root.unmount()
    } catch {
      /* already gone */
    }
    container.remove()
  }
}
