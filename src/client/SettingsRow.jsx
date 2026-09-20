/**
 * The 「划选翻译」 row in Settings → General.
 *
 * Reads and writes the plugin's own `SettingsStore` (persisted in the browser),
 * so the row needs no host settings round-trip and works the moment the page
 * loads.
 *
 * @module dsh-translator/client/SettingsRow
 */

import React from 'react'

import { LANGUAGE_CHOICES } from '../shared/select.js'
import { CLS } from './styles.js'
import { useSnapshot } from './TranslatePane.jsx'

/** One labelled control row. */
function Field({ title, hint, children }) {
  return (
    <div className={`${CLS}-setting`}>
      <span>
        {title}
        {hint !== undefined && <small>{hint}</small>}
      </span>
      {children}
    </div>
  )
}

/**
 * @param props - `{store}` (the plugin's `SettingsStore`).
 */
export function SettingsRow({ store }) {
  const settings = useSnapshot(store)
  const update = (patch) => store.update(patch)
  return (
    <div data-dsh-translator-ui="1">
      <Field title="划选翻译" hint="在对话里划选英文后点「译」，译文显示在右侧边栏的「翻译」页签">
        <select
          value={settings.targetLanguage}
          onChange={(event) => update({ targetLanguage: event.target.value })}
        >
          {LANGUAGE_CHOICES.map((choice) => (
            <option key={choice.code} value={choice.code}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>
      <Field title="跳过代码块" hint="命令行、路径、URL 与围栏代码不送翻译，只保留占位符">
        <input
          type="checkbox"
          checked={settings.maskCode !== false}
          onChange={(event) => update({ maskCode: event.target.checked })}
        />
      </Field>
      <Field title="翻译 Think 推理" hint="在「翻译」页签里显示推理行的中文">
        <input
          type="checkbox"
          checked={settings.includeReasoning !== false}
          onChange={(event) => update({ includeReasoning: event.target.checked })}
        />
      </Field>
      <Field title="翻译正文" hint="工具调用前后的中间步骤正文">
        <input
          type="checkbox"
          checked={settings.includeText !== false}
          onChange={(event) => update({ includeText: event.target.checked })}
        />
      </Field>
      <Field title="快捷键" hint="对当前选区直接翻译（无需点按钮）">
        <input
          type="text"
          value={settings.shortcut ?? ''}
          style={{ width: '140px' }}
          onChange={(event) => update({ shortcut: event.target.value })}
        />
      </Field>
    </div>
  )
}
