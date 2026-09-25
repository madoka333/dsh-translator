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

import { AUTO_DETECT_LABEL, LANGUAGE_CHOICES, SOURCE_AUTO, TRANSLATION_MODES } from '../shared/select.js'
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
 * @param props - `{store}` (the plugin's `SettingsStore`).
 */
export function SettingsRow({ store }) {
  const settings = useSnapshot(store)
  const update = (patch) => store.update(patch)
  // The pair and the gear live in ONE place each, and the pair is what the
  // toolbar shows: editing here and there must not be able to disagree, so both
  // read and write the same three fields.
  const target = settings.targetLanguage ?? 'zh-CN'
  const source = settings.sourceLanguage ?? SOURCE_AUTO
  const conflict = source !== SOURCE_AUTO && source === target
  return (
    <div data-dsh-translator-ui="1">
      <Field
        title="翻译语言对"
        hint={
          conflict
            ? '源语言与目标语言相同：这种组合不会送翻译，改其中一侧即可'
            : '源语言选「自动检测」即可，目标语言默认中文'
        }
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <LanguageSelect
            value={source}
            allowAuto
            title="源语言"
            onChange={(value) => update({ sourceLanguage: value })}
          />
          <span aria-hidden="true">→</span>
          <LanguageSelect
            value={target}
            allowAuto={false}
            title="目标语言"
            onChange={(value) => update({ targetLanguage: value })}
          />
        </span>
      </Field>
      <Field title="翻译挡位" hint="同一段文本在不同挡位下用不同风格重译；换挡会重译已有卡片，换回来是缓存命中">
        <select value={settings.mode ?? 'general'} onChange={(event) => update({ mode: event.target.value })}>
          {TRANSLATION_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </Field>
      <Field title="自定义要求" hint="只对「自定义」挡位生效；留空时按「通用」处理，最多 400 字">
        <input
          type="text"
          value={settings.customInstruction ?? ''}
          placeholder="例如：面向运维同事，保留所有命令与报错原文"
          maxLength={400}
          style={{ width: '300px' }}
          onChange={(event) => update({ customInstruction: event.target.value })}
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
