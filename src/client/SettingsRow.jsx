/**
 * The 「划选翻译」 row in Settings → General.
 *
 * Reads the plugin's own `SettingsStore` (persisted in the browser), so the row
 * needs no host settings round-trip and works the moment the page loads.
 *
 * The pair, the gear and the custom requirement are written through the plugin's
 * RUNTIME, not straight into the store. They are the same three fields the toolbar
 * edits, and the toolbar's setters do two things a bare `store.update` cannot: repair
 * a pair that would refuse every translation, and re-run the cards that were
 * translated under the old setting. Editing the same value in two places with two
 * different effects is how the toolbar ended up saying 日本語 while the cards stayed
 * Chinese.
 *
 * @module dsh-translator/client/SettingsRow
 */

import React from 'react'

import {
  AUTO_DETECT_LABEL,
  LANGUAGE_CHOICES,
  SOURCE_AUTO,
  TRANSLATION_MODES,
  nextPairAfterSource,
  nextPairAfterTarget,
  sanitizeInstruction,
} from '../shared/select.js'
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

/** One language dropdown; `allowAuto` adds the detect-everything option. */
function LanguageSelect({ value, allowAuto, title, onChange }) {
  return (
    <select value={value} title={title} onChange={(event) => onChange(event.target.value)}>
      {allowAuto && <option value={SOURCE_AUTO}>{AUTO_DETECT_LABEL}</option>}
      {LANGUAGE_CHOICES.map((choice) => (
        <option key={choice.code} value={choice.code}>
          {choice.label}
        </option>
      ))}
    </select>
  )
}

/**
 * @param props - `{store, runtime}`; `runtime` is optional so a host that renders the
 *   row without the pane (a test harness, a composition without the toolbar) still
 *   gets a working row — it then repairs the pair locally.
 */
export function SettingsRow({ store, runtime }) {
  const settings = useSnapshot(store)
  const update = (patch) => store.update(patch)
  const target = settings.targetLanguage ?? 'zh-CN'
  const source = settings.sourceLanguage ?? SOURCE_AUTO
  const conflict = source !== SOURCE_AUTO && source === target

  const changeSource = (value) => {
    if (typeof runtime?.setSourceLanguage === 'function') {
      runtime.setSourceLanguage(value)
      return
    }
    const next = nextPairAfterSource({ source, target }, value, null)
    update({ sourceLanguage: next.source, targetLanguage: next.target })
  }

  const changeTarget = (value) => {
    if (typeof runtime?.setTargetLanguage === 'function') {
      runtime.setTargetLanguage(value)
      return
    }
    const next = nextPairAfterTarget({ source, target }, value, null)
    update({ sourceLanguage: next.source, targetLanguage: next.target })
  }

  const changeMode = (value) => {
    if (typeof runtime?.setMode === 'function') runtime.setMode(value)
    else update({ mode: value })
  }

  const changeInstruction = (value) => {
    if (typeof runtime?.setCustomInstruction === 'function') runtime.setCustomInstruction(value)
    else update({ customInstruction: value })
  }

  return (
    <div data-dsh-translator-ui="1">
      <Field
        title="翻译语言对"
        hint={
          conflict
            ? '源语言与目标语言相同：这种组合不会送翻译，改其中一侧即可'
            : '源语言选「自动检测」即可，目标语言默认中文；这里改和目标语言下拉是同一份设置'
        }
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <LanguageSelect value={source} allowAuto title="源语言" onChange={changeSource} />
          <span aria-hidden="true">→</span>
          <LanguageSelect value={target} allowAuto={false} title="目标语言" onChange={changeTarget} />
        </span>
      </Field>
      <Field title="翻译挡位" hint="同一段文本在不同挡位下用不同风格重译；换挡会重译已有卡片，换回来是缓存命中">
        <select value={settings.mode ?? 'general'} onChange={(event) => changeMode(event.target.value)}>
          {TRANSLATION_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </Field>
      <Field title="自定义要求" hint="只对「自定义」挡位生效；留空时按「通用」处理，最多 400 字。改动会让该挡位的卡片重译">
        <input
          type="text"
          value={settings.customInstruction ?? ''}
          placeholder="例如：面向运维同事，保留所有命令与报错原文"
          maxLength={400}
          style={{ width: '300px' }}
          onChange={(event) => changeInstruction(event.target.value)}
          onBlur={(event) => {
            // The prompt only ever sees the sanitized single-line form, so what the
            // box shows after leaving it is what the model would get.
            const clean = sanitizeInstruction(event.target.value)
            if (clean !== event.target.value) changeInstruction(clean)
          }}
        />
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
