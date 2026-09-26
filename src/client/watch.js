/**
 * dsh-translator client selection watcher: turn a real mouse selection in the
 * conversation into a `{text, rect}` candidate for the floating trigger.
 *
 * Deliberately conservative: the floating button appears only for a non-empty
 * selection inside the conversation surface (never the composer, the sidebar, or
 * this plugin's own UI). Because the button is the only thing that can trigger a
 * paid model call, over-triggering is the failure mode worth avoiding.
 *
 * @module dsh-translator/client/watch
 */

import { classifySelection, languageLabel, languageShortLabel, targetCodeOf } from '../shared/select.js'

/** Selectors whose subtree is off-limits (composer, panels, our own UI). */
const BLOCKED_SELECTOR = [
  '[contenteditable="true"]',
  'textarea',
  'input',
  '[data-dsh-translator-ui]',
  '[data-dsh-translator-block]',
].join(',')

/** Attribute every node this plugin renders carries, so we can recognise our own chrome. */
const OWN_UI_ATTR = 'data-dsh-translator-ui'

/** Fallback viewport used when a headless environment reports none. */
const FALLBACK_VIEWPORT = { width: 1280, height: 800 }

/** Ancestor hints that identify the conversation rendering surface. */
const CHAT_HINT_RE = /(message|markdown|chat|conversation|reasoning|assistant|think)/i

/** Request payload cap for one reference (characters). */
const MAX_SELECTION_CHARS = 8000

/** True when the node belongs to this plugin's own chrome or an editable field. */
function isBlockedNode(node) {
  try {
    const element = node?.nodeType === 1 ? node : node?.parentElement
    if (element === null || element === undefined) return false
    return element.closest(BLOCKED_SELECTOR) !== null
  } catch {
    return true
  }
}

/**
 * Whether a node (or any ancestor) is part of this plugin's own UI.
 *
 * The watcher uses this to tell a press on the trigger/pane apart from a press on
 * the conversation: pressing our own chrome must NOT dismiss it, or the button is
 * unmounted during `mousedown` and the following `click` has no target to fire
 * on — the "button does nothing" failure.
 *
 * @param node - event target or any element/node.
 * @returns true when the node sits inside `[data-dsh-translator-ui]`.
 */
export function isOwnUiNode(node) {
  try {
    const element = node?.nodeType === 1 ? node : node?.parentElement
    if (element === null || element === undefined) return false
    if (typeof element.closest === 'function') return element.closest(`[${OWN_UI_ATTR}]`) !== null
    return typeof element.hasAttribute === 'function' && element.hasAttribute(OWN_UI_ATTR)
  } catch {
    return false
  }
}

/** Viewport size with a sane fallback for headless/SSR-ish environments. */
export function viewportRect() {
  const width = Number.isFinite(globalThis.innerWidth) ? globalThis.innerWidth : FALLBACK_VIEWPORT.width
  const height = Number.isFinite(globalThis.innerHeight) ? globalThis.innerHeight : FALLBACK_VIEWPORT.height
  return { left: 0, top: 0, right: width, bottom: height, width, height }
}

/** Walk up from a node looking for conversation-surface evidence. */
function insideChatSurface(node) {
  let element = node?.nodeType === 1 ? node : node?.parentElement ?? null
  let depth = 0
  while (element !== null && depth < 24) {
    const className = typeof element.className === 'string' ? element.className : ''
    if (typeof element.hasAttribute === 'function' && element.hasAttribute('data-dsh-chat-area')) return true
    if (CHAT_HINT_RE.test(className)) return true
    const role = element.getAttribute?.('role')
    if (role === 'log' || role === 'list') return true
    element = element.parentElement
    depth += 1
  }
  return false
}

/** Whether the selection's ancestors include a code block. */
function insideCodeBlock(node) {
  try {
    const element = node?.nodeType === 1 ? node : node?.parentElement
    if (element === null || element === undefined) return false
    return element.closest('pre, code, [data-language]') !== null
  } catch {
    return false
  }
}

/** Screen rect of a Selection, plus the range's anchor rect as fallback. */
function rectOf(selection) {
  try {
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width !== 0 || rect.height !== 0) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }
    const first = range.getClientRects()[0]
    if (first !== undefined) {
      return { left: first.left, top: first.top, right: first.right, bottom: first.bottom }
    }
  } catch {
    /* fall through */
  }
  return { left: 0, top: 0, right: 0, bottom: 0 }
}

/**
 * Read the current document selection as a trigger candidate.
 * @param pointer - the mouseup/mousedown pointer position, used to place the button.
 * @param policy - `{source, target}`: the language pair the verdict is made under.
 * @returns `{action, text, reason, targetLabel, shortLabel, rect, inCodeBlock, sourceLabel}`
 *   or null when there is no usable selection.
 */
export function readSelection(pointer, policy = {}) {
  const selection = globalThis.getSelection?.()
  if (selection === null || selection === undefined) return null
  if (selection.isCollapsed === true || selection.rangeCount === 0) return null

  const text = selection.toString()
  if (text.trim() === '') return null

  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if (anchor === null || focus === null) return null
  if (isBlockedNode(anchor) || isBlockedNode(focus)) return null
  if (!insideChatSurface(anchor) && !insideChatSurface(focus)) return null

  const classified = classifySelection(text, policy)
  if (classified.action === 'ignore') return null

  const target = targetCodeOf(policy)
  const rect = rectOf(selection)
  const viewport = viewportRect()
  const pointerLeft = Math.min(Math.max(pointer?.left ?? rect.right, 0), viewport.width)
  const pointerTop = Math.min(Math.max(pointer?.top ?? rect.bottom, 0), viewport.height)
  // Truncate by CODE POINT, not by UTF-16 index: the cap counts code points, so a
  // UTF-16 slice could cut an astral character (an emoji, a rare CJK extension) in
  // half and send a lone surrogate that the host then replaces with U+FFFD.
  const points = [...classified.text]
  return {
    action: classified.action,
    reason: classified.reason,
    // The pill's copy is about the TARGET language, so it has to be told which
    // one that is: "already Chinese" is wrong copy the moment the target moves.
    targetLabel: languageLabel(target),
    shortLabel: languageShortLabel(target),
    text: points.slice(0, MAX_SELECTION_CHARS).join(''),
    truncated: points.length > MAX_SELECTION_CHARS,
    rect: { ...rect, pointerLeft, pointerTop },
    inCodeBlock: insideCodeBlock(anchor) || insideCodeBlock(focus),
    sourceLabel: insideCodeBlock(anchor) || insideCodeBlock(focus) ? '代码块' : '对话内容',
  }
}

/**
 * Decide what one `mousedown` means for the floating trigger.
 *
 * Pure on purpose: this is the exact decision that regressed into "the button
 * cannot be clicked", so it is unit-tested directly instead of only through a
 * simulated browser event.
 *
 * - a right/middle press leaves everything alone;
 * - a press on our own UI (the trigger, the pane, the fallback card) records the
 *   pointer but does NOT dismiss — the element has to survive until `click`;
 * - any other press starts a new gesture and dismisses the previous trigger.
 *
 * @param event - the mousedown event (only `button`, `target`, `clientX/Y` are read).
 * @param current - the previous pointer state, or null.
 * @param now - timestamp recorded with the gesture.
 * @returns the next `pointers` entry plus whether to dismiss the trigger.
 */
export function handleMouseDown(event, current, now) {
  if (event?.button !== 0) return { pointers: current, dismissed: false }
  const point = { left: event.clientX ?? 0, top: event.clientY ?? 0, at: now ?? Date.now() }
  if (isOwnUiNode(event?.target)) return { pointers: point, dismissed: false }
  return { pointers: point, dismissed: true }
}

/**
 * Install the document-level selection listener.
 * @param handler - called with the candidate (or null when nothing is selected).
 * @param policyOf - returns the current `{source, target}` pair; read at the
 *   moment of the selection, so changing the pair takes effect immediately.
 * @returns teardown function.
 */
export function watchSelection(handler, policyOf = () => ({})) {
  let pointers = null

  const onDismiss = () => handler(null)

  const onKeyDownEscape = (event) => {
    if (event.key === 'Escape') onDismiss()
  }

  const onPointerDown = (event) => {
    const decision = handleMouseDown(event, pointers, Date.now())
    pointers = decision.pointers
    if (decision.dismissed) onDismiss()
  }

  const onPointerUp = (event) => {
    pointers = null
    // Do not let a press that started and ended on our own chrome re-run the
    // selection path: the trigger's own click handler already owns that gesture.
    if (isOwnUiNode(event?.target)) return
    // Read the selection in the same window the browser keeps it: it survives
    // until the click, and the button below lives long enough to be clicked.
    let policy = {}
    try {
      policy = policyOf() ?? {}
    } catch {
      /* a broken settings read must not cost the user their selection */
    }
    handler(readSelection({ left: event.clientX, top: event.clientY }, policy))
  }

  document.addEventListener('mousedown', onPointerDown, true)
  document.addEventListener('mouseup', onPointerUp, true)
  document.addEventListener('keydown', onKeyDownEscape, true)
  window.addEventListener('scroll', onDismiss, true)
  window.addEventListener('resize', onDismiss)

  return () => {
    document.removeEventListener('mousedown', onPointerDown, true)
    document.removeEventListener('mouseup', onPointerUp, true)
    document.removeEventListener('keydown', onKeyDownEscape, true)
    window.removeEventListener('scroll', onDismiss, true)
    window.removeEventListener('resize', onDismiss)
  }
}
