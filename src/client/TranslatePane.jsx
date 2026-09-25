/**
 * The sidebar 「翻译」 pane: the reference list, its toolbar, and the drop zone
 * that turns a dropped selection into another reference.
 *
 * Renders inside the right sidebar's tab body seat (or, when that column is not
 * mounted, inside the plugin's own floating card). All state comes from the
 * `RefsStore` prop, so both hosts render exactly the same thing.
 *
 * @module dsh-translator/client/TranslatePane
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { LANGUAGE_CHOICES } from '../shared/select.js'
import { CLS } from './styles.js'
import { readDraft, writeDraft } from './stores.js'

/** Stable empty store used only by the title's no-store fallback. */
const EMPTY_STORE = {
  getSnapshot: () => ({ refs: [], active: null }),
  subscribe: () => () => {},
}

/**
 * Render failures seen by this module, newest first.
 *
 * Kept in module scope on purpose: a component that throws during render cannot
 * rely on a scheduled `setState` landing (React may retry and then unmount the
 * subtree), so the authoritative record for the `?dsht-debug=1` self-report is this
 * log, not component state.
 */
const renderFailures = []

/** @param error - the thrown value. @returns the recorded message. */
export function recordRenderFailure(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  renderFailures.unshift(message)
  if (renderFailures.length > 5) renderFailures.length = 5
  return message
}

/** @returns the recorded render failures, newest first. */
export function renderFailureLog() {
  return [...renderFailures]
}

/**
 * Start collecting uncaught errors and unhandled rejections.
 *
 * When a slot render throws and React abdicates the entry, the only trace left is
 * the console — which is exactly what cannot be read from the outside. Capturing
 * here means the `?dsht-debug=1` panel can print the real exception that killed the
 * pane, even though that exception was raised by React's own render pass.
 *
 * Called once from `apply`, before anything is registered.
 */
export function installErrorCapture() {
  if (typeof globalThis.addEventListener !== 'function') return
  if (errorCaptureInstalled) return
  errorCaptureInstalled = true
  globalThis.addEventListener('error', (event) => {
    const error = event?.error ?? event?.message
    if (error !== undefined) recordRenderFailure(error)
  })
  globalThis.addEventListener('unhandledrejection', (event) => {
    if (event?.reason !== undefined) recordRenderFailure(event.reason)
  })
}

/** Guard so the listeners are added once per page, not once per apply. */
let errorCaptureInstalled = false

/** Subscribe to one observable store. */
export function useSnapshot(store) {
  const [snapshot, setSnapshot] = useState(() => store.getSnapshot())
  useEffect(() => {
    setSnapshot(store.getSnapshot())
    return store.subscribe(() => setSnapshot(store.getSnapshot()))
  }, [store])
  return snapshot
}

/** A snapshot that keeps the pane renderable when the store itself is broken. */
const SAFE_EMPTY_SNAPSHOT = { refs: [], active: null }

/**
 * Read a store snapshot without ever throwing, for use in the hook phase.
 *
 * A store whose `getSnapshot`/`subscribe` throws would otherwise take the pane down
 * with it: React abdicates the slot entry and the user sees an empty column. Here
 * the read degrades to an empty snapshot plus a recorded failure, which the pane
 * renders as an explanation.
 *
 * @param store - the observable store, possibly broken.
 * @returns `{snapshot, failure}`; `failure` is the recorded message, or null.
 */
export function useSafeSnapshot(store) {
  const usable = store !== null && store !== undefined && typeof store.getSnapshot === 'function'
  const [snapshot, setSnapshot] = useState(() => {
    if (!usable) return SAFE_EMPTY_SNAPSHOT
    try {
      return store.getSnapshot()
    } catch (error) {
      recordRenderFailure(error)
      return SAFE_EMPTY_SNAPSHOT
    }
  })
  useEffect(() => {
    if (!usable) return undefined
    try {
      setSnapshot(store.getSnapshot())
      return store.subscribe(() => {
        try {
          setSnapshot(store.getSnapshot())
        } catch {
          /* a store that fails on a later read keeps the last good snapshot */
        }
      })
    } catch (error) {
      recordRenderFailure(error)
      return undefined
    }
  }, [store, usable])
  const failure = usable ? null : 'store 不可用（缺少 getSnapshot）'
  return { snapshot: snapshot ?? SAFE_EMPTY_SNAPSHOT, failure }
}

/** Copy text to the clipboard, reporting success. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}

/** Localized status label. */
function statusLabel(ref) {  switch (ref.status) {
    case 'pending':
      return '排队中'
    case 'streaming':
      return '翻译中…'
    case 'done':
      return ref.cached ? '来自缓存' : '完成'
    case 'cancelled':
      return '已取消'
    case 'error':
      return '失败'
    default:
      return ref.status
  }
}

/**
 * `provider/model` → `model`, for the meta row.
 *
 * The full route is the longest string on the card and it is the same value on every
 * card, so it was dominating a row the eye should be scanning for the STATUS. The
 * provider stays available in the tooltip.
 * @param route - the route label as the host reports it.
 * @returns the model part, or the whole label when there is no slash.
 */
function modelLabel(route) {
  const value = String(route ?? '')
  const slash = value.lastIndexOf('/')
  return slash === -1 ? value : value.slice(slash + 1)
}

/**
 * One reference card.
 *
 * The reference arrives as `item`, NOT as `ref`: `ref` is a React-reserved prop
 * name, so `createElement(RefCard, { ref })` makes React treat the value as an
 * element ref, strip it from props, and hand the component `undefined`. That
 * crashed the pane's seat the moment a card had to render — the sidebar showed
 * the slot's error cell instead of any card.
 *
 * The meta row opens with the source label and then a spacer that pushes the badges
 * to the right edge. That order is load-bearing: the browser probe reads the FIRST
 * `span` inside `.dsht-meta` as the card's label, so the spacer must come after it.
 */
function RefCard({ item, onRetry, onRemove, onCancel, onCopy }) {
  const ref = item
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`${CLS}-card`} data-dsh-translator-ui="1" data-active={String(expanded)}>
      <div className={`${CLS}-meta`}>
        {ref.sourceLabel !== '' && <span>{ref.sourceLabel}</span>}
        <span className={`${CLS}-spacer`} />
        {ref.kind === 'reasoning' && <span className={`${CLS}-badge`}>Think</span>}
        <span className={`${CLS}-badge`} data-state={ref.status}>
          {statusLabel(ref)}
        </span>
        {ref.routeLabel !== '' && (
          <span title={'本次翻译所用模型：' + ref.routeLabel}>{modelLabel(ref.routeLabel)}</span>
        )}
        <span>{[...ref.text].length} 字</span>
      </div>
      <div
        className={`${CLS}-src`}
        data-open={String(expanded)}
        title={expanded ? '点击收起原文' : '点击展开原文'}
        onClick={() => setExpanded((value) => !value)}
      >
        {ref.text}
      </div>
      <div className={`${CLS}-out`} data-empty={String(ref.translation === '')}>
        {ref.translation !== '' ? ref.translation : ref.status === 'error' ? '（未产出译文）' : '等待译文…'}
      </div>
      {ref.error !== null && ref.error !== undefined && <div className={`${CLS}-err`}>{ref.error}</div>}
      <div className={`${CLS}-acts`}>
        <button type="button" onClick={() => onCopy(ref.translation)} disabled={ref.translation === ''}>
          复制译文
        </button>
        <button type="button" onClick={() => onCopy(ref.text)}>
          复制原文
        </button>
        {ref.status === 'streaming' || ref.status === 'pending' ? (
          <button type="button" onClick={() => onCancel(ref.key)}>
            取消
          </button>
        ) : (
          <button type="button" onClick={() => onRetry(ref.key)}>
            重新翻译
          </button>
        )}
        <button type="button" onClick={() => onRemove(ref.key)}>
          删除
        </button>
      </div>
    </div>
  )
}

/**
 * The bottom composer: stage text, commit it as one more reference.
 *
 * It is deliberately NOT a chat channel — the plugin's contract is that nothing it
 * shows or collects ever reaches the session log or the model's context, and a real
 * chat box would break exactly that. What this does is the same thing the floating
 * 「译」 button does, for text you would rather type or paste than select: Enter
 * turns the box's content into a reference, and the existing translate pipeline
 * takes it from there. Shift+Enter inserts a newline.
 *
 * The draft is kept per Session (the `dsh-translator:draft:` key prefix plus the
 * Session id) and persisted on every keystroke, so a refresh never eats what you
 * were in the middle of typing. The component is mounted with `key={sessionKey}`:
 * switching Sessions remounts it, which is what makes "load the incoming Session's
 * draft" a plain `useState` initializer instead of a race between two effects.
 *
 * @param props - `{runtime, sessionKey, onNotice}`.
 */
function Composer({ runtime, sessionKey, onNotice }) {
  const [text, setText] = useState(() => readDraft(sessionKey))
  const [composing, setComposing] = useState(false)

  /** Every edit goes to the draft store immediately — there is no flush button. */
  const update = useCallback(
    (next) => {
      setText(next)
      writeDraft(sessionKey, next)
    },
    [sessionKey],
  )

  const commit = useCallback(() => {
    if (text.trim() === '') return
    if (typeof runtime?.addManual !== 'function') {
      onNotice?.('这个宿主不支持手动输入')
      return
    }
    const result = runtime.addManual(text)
    if (result?.ok === true) {
      update('')
      onNotice?.(`已加入翻译（${[...(result.text ?? text)].length} 字）`)
      return
    }
    if (result?.reason === 'already-chinese') {
      onNotice?.('这段已经是中文了，没有送翻译')
      return
    }
    onNotice?.('没有可翻译的内容')
  }, [onNotice, runtime, text, update])

  const onKeyDown = useCallback(
    (event) => {
      if (event.key !== 'Enter') return
      // An Enter that ends an IME candidate window belongs to the input method, not
      // to us: without this guard, typing Chinese and picking a candidate would
      // submit half a word.
      if (composing || event.nativeEvent?.isComposing === true) return
      if (event.shiftKey) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      commit()
    },
    [commit, composing],
  )

  /**
   * Stage a drop instead of letting it through.
   *
   * The box is a controlled `value`, so the browser's own insert-into-textarea is
   * overwritten on the next render — a drop would look like it did nothing. And
   * letting the event bubble would ALSO reach the pane's own drop handler, which
   * adds the text as a reference: one drop, translated twice.
   */
  const onDrop = useCallback(
    (event) => {
      const dropped = event.dataTransfer?.getData('text/plain') ?? ''
      if (dropped.trim() === '') return
      event.preventDefault()
      event.stopPropagation()
      update(text.trim() === '' ? dropped : `${text}\n${dropped}`)
    },
    [text, update],
  )

  return (
    <div className={`${CLS}-composer`} data-dsh-translator-ui="1">
      <button
        type="button"
        className={`${CLS}-send`}
        disabled={text.trim() === ''}
        title="翻译输入框里的内容"
        onClick={commit}
      >
        翻译
      </button>
      <textarea
        className={`${CLS}-input`}
        value={text}
        rows={2}
        spellCheck={false}
        aria-label="输入要翻译的内容"
        placeholder="输入或粘贴内容，回车即翻译（Shift+Enter 换行）"
        onChange={(event) => update(event.target.value)}
        onKeyDown={onKeyDown}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  )
}

/**
 * @param props - `{store, runtime, sessionKey}` where `runtime` is
 * `{addRef, addManual, retry, cancel, remove, clear, setLanguage, language}` and
 * `sessionKey` is the Session the pane is seated in.
 *
 * `sessionKey` arrives as the slot's own `sessionId` prop: `sidebar.right.pane.tab`
 * is a `session`-scoped keyed slot, so the framework resolves it and no service
 * call is needed. Switching Sessions re-renders the seat with a new value, which is
 * what keeps one Session's references out of another's list.
 */
export function TranslatePane({ store, runtime, sessionKey }) {
  // The snapshot is read through a guarded helper: this line runs INSIDE the hook
  // phase, where a throw escapes any try/catch placed after it and abdicates the
  // whole seat (empty pane, only a `data-slot-error` marker in the DOM).
  const { snapshot, failure: readFailure } = useSafeSnapshot(store)
  const [dragover, setDragover] = useState(false)
  const [notice, setNotice] = useState('')

  // Re-scope the store to the Session this seat belongs to. Declared AFTER
  // `useSafeSnapshot` so the subscription is live before the switch commits, and
  // deliberately not in the snapshot read itself: a store whose `setSession`
  // throws must not take the pane's first render down with it. A store without
  // `setSession` (the test harness, a foreign host) is simply left alone.
  useEffect(() => {
    if (typeof sessionKey !== 'string' || sessionKey === '') return
    try {
      store?.setSession?.(sessionKey)
    } catch (error) {
      recordRenderFailure(error)
      console.warn('[dsh-translator] 切换会话命名空间失败:', error)
    }
  }, [store, sessionKey])

  const refs = snapshot.refs

  const flash = useCallback((message) => {
    setNotice(message)
    setTimeout(() => setNotice(''), 1800)
  }, [])

  const handleCopy = useCallback(
    async (text) => {
      if (text === '') return
      flash((await copyText(text)) ? '已复制到剪贴板' : '复制失败，请手动选择')
    },
    [flash],
  )

  const onDrop = useCallback(
    (event) => {
      event.preventDefault()
      setDragover(false)
      const text = event.dataTransfer?.getData('text/plain') ?? ''
      if (text.trim() === '') return
      runtime.addRef(text, { kind: 'selection', sourceLabel: '拖拽引用' })
    },
    [runtime],
  )

  // A failure recorded during the hook phase is rendered here, before anything
  // else, so the user sees why the pane is not showing their references.
  if (readFailure !== null) return failurePanel(readFailure)

  // Everything past the hooks is guarded: a failure here is recorded and rendered
  // as a readable panel, never thrown out of the component. Throwing would abdicate
  // the whole seat and leave the column showing an empty pane with only a
  // `data-slot-error` marker in the DOM — invisible to the user.
  try {
    // The composer is mounted with `key={sessionKey}` on purpose: switching Sessions
    // remounts it, so loading the incoming Session's draft is a `useState`
    // initializer rather than a race between a persist effect and a load effect.
    //
    // `sessionKey` is never handed over as `undefined`: a slot host is entitled to
    // treat an undefined prop as a wiring mistake, and the draft store already maps
    // '' to the shared bucket.
    const composer = (
      <Composer
        key={sessionKey ?? 'default'}
        runtime={runtime}
        sessionKey={typeof sessionKey === 'string' ? sessionKey : ''}
        onNotice={flash}
      />
    )
    return renderPane({ refs, runtime, notice, dragover, setDragover, onDrop, handleCopy, composer })
  } catch (error) {
    console.error('[dsh-translator] 面板渲染失败:', error)
    return failurePanel(recordRenderFailure(error))
  }
}

/** The panel shown when the pane cannot render; the same text the self-report logs. */
function failurePanel(message) {
  return (
    <div className={`${CLS}-pane`} data-dsh-translator-ui="1" data-dsh-translator-error="1">
      <div className={`${CLS}-empty`}>
        <div>翻译面板渲染失败</div>
        <div className={`${CLS}-err`}>{message}</div>
        <div>打开 ?dsht-debug=1 可看到完整自检（左下角）。</div>
      </div>
    </div>
  )
}

/** The pane's markup, kept separate so the caller can guard it in one place. */
function renderPane({ refs, runtime, notice, dragover, setDragover, onDrop, handleCopy, composer }) {
  return (
    <div
      className={`${CLS}-pane`}
      data-dsh-translator-ui="1"
      data-dragover={String(dragover)}
      onDragOver={(event) => {
        event.preventDefault()
        setDragover(true)
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={onDrop}
    >
      <div className={`${CLS}-bar`}>
        <span className={`${CLS}-select`}>
          <select
            value={runtime.language}
            title="目标语言"
            onChange={(event) => runtime.setLanguage(event.target.value)}
          >
            {LANGUAGE_CHOICES.map((choice) => (
              <option key={choice.code} value={choice.code}>
                {choice.label}
              </option>
            ))}
          </select>
        </span>
        <span className={`${CLS}-spacer`} />
        <span className={`${CLS}-beta`} title="dsh-translator beta 分支：底部输入框">
          beta
        </span>
        <span className={`${CLS}-count`}>{notice !== '' ? notice : `${refs.length} 条引用`}</span>
        <button type="button" onClick={() => runtime.clear()} disabled={refs.length === 0}>
          清空
        </button>
      </div>

      {refs.length === 0 ? (
        <div className={`${CLS}-empty`}>
          <div className={`${CLS}-empty-glyph`} aria-hidden="true">
            译
          </div>
          <div className={`${CLS}-empty-lead`}>还没有引用。</div>
          <div>
            在对话里<b>划选</b>英文 → 点 <b>译</b>
          </div>
          <div>或在下面的输入框里打字、粘贴</div>
          <div>
            快捷键 <kbd>{runtime.shortcut}</kbd>
          </div>
        </div>
      ) : (
        <div className={`${CLS}-list`}>
          {refs.map((ref) => (
            <RefCard
              key={ref.key}
              item={ref}
              onRetry={(key) => runtime.retry(key)}
              onRemove={(key) => runtime.remove(key)}
              onCancel={(key) => runtime.cancel(key)}
              onCopy={handleCopy}
            />
          ))}
        </div>
      )}

      <div className={`${CLS}-drop`}>{dragover ? '松手即翻译这段内容' : '把划选内容拖到这里也可以翻译'}</div>
      {composer}
    </div>
  )
}

/**
 * The tab chip/header text: shows the reference count and whether anything is
 * still streaming, read from the same store the body renders.
 * @param props - `{store, title}`.
 */
export function TranslateTitle({ store, title = '翻译' }) {
  // Hooks must run unconditionally: fall back to a local no-op store shape when
  // the seat passes none (a fresh object each call would break subscription, so
  // it is a module-level constant deliberately kept stable).
  const empty = EMPTY_STORE
  const snapshot = useSnapshot(store ?? empty)
  if (store === undefined) return <span>{title}</span>
  const refs = snapshot.refs
  const streaming = refs.filter((ref) => ref.status === 'streaming' || ref.status === 'pending').length
  const suffix = streaming > 0 ? ` ${streaming}…` : refs.length > 0 ? ` ${refs.length}` : ''
  return (
    <span data-dsh-translator-ui="1">
      {title}
      {suffix}
    </span>
  )
}
