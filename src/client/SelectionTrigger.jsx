/**
 * The floating 「译」 trigger: appears next to a selection in the conversation,
 * carries the selected text as a drag payload, and disappears after use.
 *
 * It is rendered into `document.body` through a portal, so the conversation's own
 * layout is never touched.
 *
 * @module dsh-translator/client/SelectionTrigger
 */

import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { isOwnUiNode } from './watch.js'
import { CLS } from './styles.js'

/** Gap between the selection and the pill (px). */
const OFFSET = 8

/** Pill size used for clamping before the first measurement. */
const APPROX_WIDTH = 96
const APPROX_HEIGHT = 28

/** How far a press may travel from the pill and still count as "pressed the pill". */
const PRESS_SLOP_PX = 48

/** Clamp a fixed-position coordinate into the viewport. */
function clamp(value, min, max) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Where the pill goes for one candidate.
 *
 * Pure and computed during RENDER, not in an effect: an effect-deferred position
 * means the first render returns `null`, and any consumer (including this
 * project's tests) that needs the pill's own element can only reach it after a
 * second pass. The maths only reads `innerWidth/Height`, so it is render-safe.
 *
 * @param candidate - the watcher payload, or null.
 * @returns `{left, top, text, meta}` or null when there is nothing to show.
 */
export function pillAnchorFor(candidate) {
  if (candidate === null || candidate === undefined) return null
  const rect = candidate.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const viewportWidth = Number.isFinite(globalThis.innerWidth) ? globalThis.innerWidth : 1280
  const viewportHeight = Number.isFinite(globalThis.innerHeight) ? globalThis.innerHeight : 800
  const top = clamp(rect.top - APPROX_HEIGHT - OFFSET, 4, viewportHeight - APPROX_HEIGHT - 4)
  const left = clamp(rect.pointerLeft ?? rect.right, 4, viewportWidth - APPROX_WIDTH - 4)
  return { left, top, text: candidate.text, meta: candidate }
}

/**
 * @param props - `{candidate, onCommit, onDismiss}`.
 * `candidate` is the watcher's payload (`{action, text, reason, rect, sourceLabel}`);
 * `onCommit(text, meta)` runs when the user actually asks for a translation.
 */
export function SelectionTrigger({ candidate, onCommit, onDismiss }) {
  const boxRef = useRef(null)
  const anchor = pillAnchorFor(candidate)

  // Drag-release safety net. A `draggable` element that is pressed and released
  // on the spot does not always produce a `click`, so a press that began at (or
  // travelled back to) the pill also commits here. Only presses that started
  // OUTSIDE our UI are considered, which keeps this from double-firing the normal
  // click path.
  const anchorRef = useRef(null)
  anchorRef.current = anchor
  const commitRef = useRef(null)
  commitRef.current = () => {
    const current = anchorRef.current
    if (current === null) return
    if (current.meta.action === 'noop') return
    onCommit(current.text, current.meta)
    onDismiss()
  }
  const pressRef = useRef(null)

  useEffect(() => {
    if (typeof document === 'undefined') return undefined

    const insidePill = (event) => {
      const box = boxRef.current
      if (box !== null && typeof box.contains === 'function' && box.contains(event.target)) return true
      return isOwnUiNode(event.target)
    }

    const onDown = (event) => {
      pressRef.current = insidePill(event)
        ? null
        : { left: event.clientX ?? 0, top: event.clientY ?? 0, inside: false }
    }

    const onUp = (event) => {
      const press = pressRef.current
      pressRef.current = null
      if (press === null || anchorRef.current === null) return
      if (!insidePill(event)) return
      const dx = (event.clientX ?? 0) - press.left
      const dy = (event.clientY ?? 0) - press.top
      // A real drag ends far away (or the browser already sent `click`); a
      // press-and-release on the spot lands within the slop and is ours.
      if (Math.hypot(dx, dy) > PRESS_SLOP_PX) return
      commitRef.current?.()
    }

    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseup', onUp, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mouseup', onUp, true)
    }
  }, [])

  if (anchor === null) return null

  const disabled = anchor.meta.action === 'noop'
  // The pill names the TARGET language, so the copy has to come from the
  // candidate (which was classified under the live pair) rather than from a
  // hard-coded "Chinese": with the target on Japanese, "已是中文" is a lie.
  const shortLabel = anchor.meta.shortLabel ?? '目标语言'

  const commit = () => {
    // An already-target-language selection is a no-op: the pill explains itself
    // and closes rather than spending a model call on text nothing would change.
    if (disabled) {
      onDismiss()
      return
    }
    onCommit(anchor.text, anchor.meta)
    onDismiss()
  }

  const title = disabled
    ? `这段内容看起来已经是${shortLabel}，不需要翻译`
    : `翻译这段内容：${anchor.text.slice(0, 60)}${anchor.text.length > 60 ? '…' : ''}`

  return createPortal(
    <div
      ref={boxRef}
      data-dsh-translator-ui="1"
      className={`${CLS}-trigger`}
      role="button"
      tabIndex={0}
      title={title}
      draggable={!disabled}
      data-drag={disabled ? undefined : '1'}
      style={{ left: `${anchor.left}px`, top: `${anchor.top}px` }}
      onMouseDown={(event) => {
        // Keep the document selection alive: the click below must be able to read
        // it (and the drag must start from a live selection). The watcher no longer
        // dismisses on our own chrome, so this preventDefault is the one that wins.
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          commit()
        }
      }}
      onDragStart={(event) => {
        try {
          event.dataTransfer.setData('text/plain', anchor.text)
          event.dataTransfer.effectAllowed = 'copy'
        } catch {
          /* some browsers refuse programmatic payloads — the click path still works */
        }
      }}
    >
      <b>译</b>
      <span>{disabled ? `已是${shortLabel}` : '翻译这段'}</span>
    </div>,
    document.body,
  )
}
