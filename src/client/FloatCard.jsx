/**
 * Fallback host for the pane when the right sidebar is not mounted in this
 * deployment: the same `TranslatePane` inside a fixed card, so selection →
 * translation still works end to end.
 *
 * @module dsh-translator/client/FloatCard
 */

import React from 'react'
import { createPortal } from 'react-dom'

import { CLS } from './styles.js'
import { TranslatePane } from './TranslatePane.jsx'

/**
 * @param props - `{store, runtime, reason, onClose}`; `reason` is the sidebar
 *   failure that forced this host, shown so the card never appears unexplained.
 */
export function FloatCard({ store, runtime, reason, onClose }) {
  return createPortal(
    <div className={`${CLS}-float`} data-dsh-translator-ui="1" role="dialog" aria-label="翻译">
      <header>
        <strong>翻译</strong>
        <span className={`${CLS}-spacer`} style={{ flex: 1 }} />
        <button type="button" onClick={onClose} title="关闭">
          ✕
        </button>
      </header>
      {reason !== undefined && reason !== '' && (
        <div className={`${CLS}-err`}>{`右侧边栏不可用，改用浮层显示：${reason}`}</div>
      )}
      <TranslatePane store={store} runtime={runtime} />
    </div>,
    document.body,
  )
}
