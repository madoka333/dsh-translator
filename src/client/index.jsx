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

import { chunkText, classifySelection, maskCode, restoreCode } from '../shared/select.js'
import { provenanceFor, readChatSnapshot } from './chat.js'
import { FloatCard } from './FloatCard.jsx'
import { translate } from './query.js'
import { SelectionTrigger, pillAnchorFor } from './SelectionTrigger.jsx'
import { SettingsRow } from './SettingsRow.jsx'
import { RefsStore, SettingsStore } from './stores.js'
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

/** Required services: slot registry, right sidebar and its tab registry, the
 * session list (storage namespace), the chat read channel, and settings. */
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiConversation', 'settingsScope']

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
const BUNDLE_STAMP = 'client-2026-09-12T04:00Z-hardsafe'

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

/** The active Session id from the sessions list snapshot. */
function activeSessionId(sessions) {
  try {
    const snapshot = sessions?.list?.getSnapshot?.()
    const current = snapshot?.current
    return typeof current === 'string' && current !== '' ? current : 'default'
  } catch {
    return 'default'
  }
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
  const store = new RefsStore(activeSessionId(ctx.sessions))

  // Portal roots render from these: `apply` has no hooks, so the two React trees
  // are driven by an explicit re-render call instead.
  const roots = new Map()
  const rerender = () => {
    for (const render of roots.values()) render()
  }

  let fallbackOpen = false
  let fallbackReason = ''
  /** Seat keys recorded at registration time, so the self-report can prove them. */
  const seatKeys = { type: '', body: '(not registered)', title: '(not registered)' }

  /** Open the sidebar pane when that column exists; otherwise reveal the card. */
  const openPane = () => {
    try {
      ctx.sidebarRight.openTab(KIND)
      return true
    } catch (cause) {
      // Never fail silently: a click that produced nothing visible is exactly the
      // bug worth preventing, so the fallback card says why it appeared.
      console.warn('[dsh-translator] 右侧边栏不可用，改用浮层卡片:', cause)
      fallbackOpen = true
      fallbackReason = cause instanceof Error ? cause.message : String(cause)
      rerender()
      return false
    }
  }

  const language = () => settings.getSnapshot().targetLanguage ?? 'zh-CN'

  /** Build the translator face for one reference: chunking, masking, SSE. */
  function translatorFor(text, kind) {
    return {
      chunks: (value) => chunkText(value),
      translate: async ({ text: unit, kind: unitKind, lang, signal, onStart, onDelta }) => {
        const masking = (settings.getSnapshot().maskCode ?? true) ? maskCode(unit) : { text: unit, spans: [] }
        if (masking.text.trim() === '') {
          // The whole unit is code: keep the original untouched.
          onDelta?.(unit)
          return unit
        }
        let whole = ''
        await translate({
          text: masking.text,
          kind: unitKind ?? kind,
          lang,
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
      const classified = classifySelection(text)
      if (classified.action === 'ignore') return null
      const snapshot = readChatSnapshot(ctx.get('uiConversation'), activeSessionId(ctx.sessions))
      const label = meta.sourceLabel ?? provenanceFor(snapshot, classified.text)
      return store.add(
        {
          text: classified.text,
          kind: meta.kind ?? 'selection',
          lang: language(),
          sourceLabel: label,
        },
        translatorFor(classified.text, meta.kind ?? 'selection'),
      )
    },
    retry: (key) => {
      const ref = store.find(key)
      store.retry(key, translatorFor(ref?.text ?? '', ref?.kind ?? 'selection'))
    },
    cancel: (key) => store.cancel(key),
    remove: (key) => store.remove(key),
    clear: () => store.clear(),
    setLanguage: (lang) => {
      settings.update({ targetLanguage: lang })
      for (const ref of store.list()) {
        if (ref.lang !== lang) store.retry(ref.key, translatorFor(ref.text, ref.kind))
      }
    },
    get language() {
      return language()
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
    // blank); that is reported so a click with no visible effect leaves a trail.
    const key = runtime.addRef(text, meta ?? { kind: 'selection', sourceLabel: '划选内容' })
    if (key === null) {
      console.warn('[dsh-translator] 选中的内容无需翻译（过短或为空），未创建引用')
      return
    }
    openPane()
  }

  // --- Selection watcher + trigger root ------------------------------------
  ctx.effect(() => {
    const teardown = watchSelection((next) => {
      lastSelection = next
      rerender()
    })
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

  // --- Sidebar tab type (two-stage registration) ---------------------------
  ctx.effect(() => {
    // The seats are dispatched with `definition.id ?? tab.kind` (see
    // `TabSlot` in ui-sidebar-right), so the BODY and TITLE registrations must key
    // on the definition id — not on the kind. Keying on the kind leaves both seats
    // unresolved and the pane renders the column's own fallback notice
    // ("这类内容还没有可用的查看方式。"), which is exactly how this broke once.
    const disposeType = ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: KIND,
      title: () => TAB_TITLE,
      guide: [
        {
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
    const PaneHost = () => React.createElement(TranslatePane, { store, runtime })
    const TitleHost = () => React.createElement(TranslateTitle, { store, title: TAB_TITLE })
    seatKeys.type = TAB_ID
    seatKeys.body = TAB_ID
    seatKeys.title = TAB_ID
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, PaneHost),
    )
    const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, TitleHost),
    )
    return () => {
      disposeTitle()
      disposeBody()
      disposeType()
    }
  }, 'dsh-translator: sidebar tab type')

  // --- Settings → General row ----------------------------------------------
  ctx.effect(() => {
    const SettingsHost = () => React.createElement(SettingsRow, { store: settings })
    return ctx.slots.inject('settings.general.item', () =>
      ctx.slots.register({ name: 'settings.general.item', id: 'translator', order: 60 }, SettingsHost),
    )
  }, 'dsh-translator: settings row')

  // --- Session switching (storage namespace) -------------------------------
  ctx.effect(() => {
    const sync = () => store.setSession(activeSessionId(ctx.sessions))
    const unsubscribe = ctx.sessions?.list?.subscribe?.(sync)
    return () => unsubscribe?.()
  }, 'dsh-translator: session scope')

  // --- Self-report (`?dsht-debug=1`) ---------------------------------------
  ctx.effect(() => {
    if (!debugRequested()) return () => {}
    const errors = renderFailureLog()
    const lines = [
      `plugin        : dsh-translator (client)`,
      `bundle        : ${BUNDLE_STAMP}（与 lib/client.js 的构建时间对照；不一致=页面跑的是旧产物，需要刷新）`,
      `styles tag    : ${typeof document !== 'undefined' && document.getElementById('dsh-translator-style') !== null}`,
      `services      : slots=${typeof ctx.slots?.register === 'function'} sidebarRight=${typeof ctx.sidebarRight?.openTab === 'function'} tabs=${typeof ctx.sidebarRightTabs?.register === 'function'} sessions=${typeof ctx.sessions?.list?.getSnapshot === 'function'}`,
      `tab id / kind : ${TAB_ID} / ${KIND}`,
      `seat keys     : body=${seatKeys.body} title=${seatKeys.title}`,
      `session       : ${activeSessionId(ctx.sessions)}`,
      `refs          : ${store.list().length}（${store.list().map((ref) => `${ref.status}:${[...(ref.translation ?? '')].length}字`).join(', ') || '空'}）`,
      `slots.snapshot: ${describeSlot(ctx, 'sidebar.right.pane.tab')}`,
      `slot.title    : ${describeSlot(ctx, 'sidebar.right.pane.tab.title')}`,
      `tab types     : ${describeTabTypes(ctx)}`,
      `openTab       : ${(() => {
        try {
          ctx.sidebarRight.openTab(KIND)
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
 * @param ctx - client context.
 * @param slot - slot name.
 * @returns a one-line summary.
 */
function describeSlot(ctx, slot) {
  try {
    const snapshot = ctx.slots?.snapshot?.(slot)
    if (snapshot === undefined || snapshot === null) return '（无快照 API）'
    const occupants = Array.isArray(snapshot.occupants) ? snapshot.occupants : []
    const described = occupants.map((entry) => `${entry.key ?? entry.id ?? '?'}${entry.active === false ? '(inactive)' : ''}`)
    return `declaredBy=${snapshot.declaredBy ?? '?'} occupants=[${described.join(', ') || '无'}]`
  } catch (error) {
    return `THREW ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Describe the registered tab types (id/kind pairs), which is what the seat key is
 * derived from.
 * @param ctx - client context.
 * @returns a one-line summary.
 */
function describeTabTypes(ctx) {
  try {
    const entries = ctx.sidebarRightTabs?.entries?.()
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
