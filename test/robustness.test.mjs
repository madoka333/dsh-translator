/**
 * Robustness sweep: the shared policy must survive whatever a browser, a
 * hand-written request, or a hand-edited localStorage blob hands it.
 *
 * Everything here is deterministic (a fixed corpus, no RNG) and every case is a
 * shape a caller can actually produce: `null`/numbers/objects from untrusted JSON,
 * lone surrogates and ZWJ emoji from real text, control characters from pasted
 * content, 8k of Han, a Symbol (which no caller can produce, and which the module is
 * therefore allowed to refuse).
 *
 * The point is not coverage of lines — it is the two invariants that a translation
 * panel must never break: **nothing throws in the user's face**, and **a guess never
 * becomes a refusal**.
 *
 * @module dsh-translator/test/robustness.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { translationKey } from '../src/shared/cache.js'
import {
  LANGUAGE_CHOICES,
  SOURCE_AUTO,
  TRANSLATION_MODES,
  chunkText,
  classifySelection,
  detectLanguage,
  effectiveSource,
  framingInput,
  isKnownMode,
  languageLabel,
  languageShortLabel,
  languageVerdict,
  looksLikeCodeLine,
  maskCode,
  missingSpans,
  modeById,
  modeLabel,
  nextPairAfterSource,
  nextPairAfterTarget,
  normalizeSelection,
  normalizeSourceCode,
  restoreCode,
  swapPair,
  targetCodeOf,
  tokensOf,
  translationSystemPrompt,
} from '../src/shared/select.js'

/** Everything a caller has ever managed to hand these functions. */
const CORPUS = [
  undefined, null, 0, -1, 1.5, Number.NaN, true, false, {}, [], () => {}, Symbol('s'),
  '', ' ', '\n', '\t', '\u0000', '\uD800', '\uDC00', 'a\uD800b', '\uFEFF', '\u200B',
  'a'.repeat(9000), '中'.repeat(5000), 'é', 'e\u0301', 'ﷺ', '👨‍👩‍👧‍👦', 'مرحبا', 'שלום',
  'auto', 'general', 'custom', '学术', '简体中文', 'English', '0', 'NaN', 'true', 'null',
  'Hello 世界', 'Hello\nworld', '```js\nconst a = 1\n```', 'https://example.com', 'C:\\p\\f.js',
  'http://', '!!!!!!', '。。。', '   \n\n   ', `${'A'.repeat(4001)}好`,
]

/** A label for a failure message, without ever throwing on the value itself. */
function label(value) {
  const type = typeof value
  const text = type === 'symbol' ? value.toString() : String(value)
  return `${type}:${text.slice(0, 24)}`
}

/** Every language code the build knows, plus the "detect it" sentinel. */
const CODES = [SOURCE_AUTO, ...LANGUAGE_CHOICES.map((choice) => choice.code)]

/** Every kind the host accepts, plus two it does not. */
const KINDS = ['reasoning', 'text', 'selection', undefined, null, 'nonsense']

test('the shared policy never throws on hostile input, and keeps its shape', () => {
  for (const value of CORPUS) {
    const where = label(value)

    // --- detection ---------------------------------------------------------
    const detected = detectLanguage(value)
    assert.ok(detected.code === null || CODES.includes(detected.code), `code for ${where}`)
    assert.equal(typeof detected.certain, 'boolean', `certain for ${where}`)
    assert.ok(detected.confidence >= 0 && detected.confidence <= 1, `confidence for ${where}`)
    assert.ok(detected.code === null ? detected.label === null : typeof detected.label === 'string', `label for ${where}`)
    assert.equal(detectLanguage(value).code, detected.code, `detection is deterministic for ${where}`)

    // --- source / target resolution ----------------------------------------
    const effective = effectiveSource(value, 'auto')
    assert.ok(effective === null || CODES.includes(effective), `effectiveSource for ${where}`)
    assert.ok(CODES.includes(normalizeSourceCode(value)), `normalizeSourceCode for ${where}`)
    assert.ok(CODES.includes(targetCodeOf({ target: value })), `targetCodeOf for ${where}`)
    assert.ok(typeof languageLabel(value) === 'string' && languageLabel(value) !== '', `languageLabel for ${where}`)
    assert.ok(
      typeof languageShortLabel(value) === 'string' && languageShortLabel(value) !== '',
      `languageShortLabel for ${where}`,
    )

    // --- gears -------------------------------------------------------------
    const gear = modeById(value)
    assert.ok(typeof gear.id === 'string' && gear.style.length > 0, `modeById for ${where}`)
    assert.equal(isKnownMode(value), TRANSLATION_MODES.some((mode) => mode.id === value), `isKnownMode for ${where}`)
    assert.ok(modeLabel(value) !== '', `modeLabel for ${where}`)

    // --- prompt ------------------------------------------------------------
    for (const kind of KINDS) {
      for (const mode of ['general', 'academic', 'custom', value]) {
        const prompt = translationSystemPrompt(languageLabel(value), kind, {
          source: value,
          mode,
          customInstruction: value,
        })
        assert.ok(prompt.includes('Rules:'), `prompt for ${where}/${kind}/${String(mode).slice(0, 10)}`)
        assert.ok(prompt.includes('1. Output ONLY the translation.'), `rule 1 for ${where}`)
        assert.ok(prompt.includes('6. If a span is already in the target language'), `rule 6 for ${where}`)
        assert.equal(/\bundefined\b/.test(prompt), false, `no literal undefined in the prompt for ${where}`)
      }
    }

    // --- the pair ----------------------------------------------------------
    for (const pair of [{ source: value, target: 'en' }, { source: 'en', target: value }, { source: value, target: value }, {}, null]) {
      for (const next of [swapPair(pair, value), nextPairAfterSource(pair, value, value), nextPairAfterTarget(pair, value, value)]) {
        assert.ok(CODES.includes(next.source), `pair source ${next.source} for ${where}`)
        assert.ok(CODES.includes(next.target) && next.target !== SOURCE_AUTO, `pair target for ${where}`)
        assert.notEqual(next.source, next.target, `a pair must never collapse (${where})`)
      }
    }

    // --- the verdict -------------------------------------------------------
    for (const target of ['zh-CN', 'en', 'ja']) {
      for (const source of [SOURCE_AUTO, 'en', 'zh-CN']) {
        const policy = { source, target }
        assert.doesNotThrow(() => classifySelection(value, policy), `classifySelection for ${where}`)
        const selection = classifySelection(value, policy)
        const verdict = languageVerdict(value, policy)
        assert.ok(['ignore', 'noop', 'translate'].includes(selection.action), `action for ${where}`)
        if (selection.action === 'translate') assert.notEqual(selection.text, '', `empty translate for ${where}`)
        // The iron rule: only a CERTAIN detection (of the text, or of a text the
        // user pinned to the target) may refuse. A pinned source may be uncertain.
        if (verdict.reason === 'same-language' && source === SOURCE_AUTO) {
          assert.equal(verdict.detected?.certain, true, `refused on an uncertain detection for ${where}`)
        }
      }
    }

    // --- masking / chunking ------------------------------------------------
    const masked = maskCode(value)
    assert.equal(typeof masked.text, 'string', `maskCode for ${where}`)
    assert.equal(typeof restoreCode(masked.text, masked.spans), 'string', `restoreCode for ${where}`)
    assert.ok(Array.isArray(missingSpans(masked.text, masked.spans)), `missingSpans for ${where}`)
    assert.ok(Array.isArray(chunkText(value)), `chunkText for ${where}`)
    assert.equal(typeof framingInput(value, value), 'string', `framingInput for ${where}`)
    assert.equal(typeof normalizeSelection(value), 'string', `normalizeSelection for ${where}`)
    assert.equal(typeof looksLikeCodeLine(value), 'boolean', `looksLikeCodeLine for ${where}`)
    assert.ok(Array.isArray(tokensOf(value)), `tokensOf for ${where}`)

    // --- the cache key -----------------------------------------------------
    if (typeof value !== 'symbol') {
      // A Symbol cannot be interpolated into a string at all, and no caller can reach
      // this with one (the host receives JSON). The key always carries its six
      // separators, so a missing FIELD can never be mistaken for the text.
      const key = translationKey(value, languageLabel(value), { provider: 'p', model: 'm' }, {
        mode: value,
        source: value,
        style: value,
      })
      assert.equal(typeof key, 'string', `translationKey for ${where}`)
      assert.ok(key.startsWith('p\u0000m\u0000'), `translationKey prefix for ${where}`)
    }
  }
})

test('a refusal is never reachable from an uncertain detection', () => {
  // The corpus above proves it for hostile input; this pins the mundane cases that a
  // wrong `certain` would break — each one was a real false refusal at some point.
  const cases = [
    // Ukrainian is not Russian, Persian is not Arabic, Marathi is not Hindi.
    ['Перевір структуру репозиторію і скажи, що треба змінити.', 'ru'],
    ['لطفا ساختار پوشه را بررسی کن و بعد بگو چه چیزی را باید تغییر بدهم.', 'ar'],
    ['रिपॉजिटरी की संरचना जांचें और बताएं क्या बदलना है।', 'hi'],
    // Portuguese shares half its function words with Spanish.
    ['O que se pode fazer aqui?', 'es'],
    ['Se o teste falhar, tente outra vez.', 'es'],
    ['Se nao funcionar, tente outra vez.', 'vi'],
  ]
  for (const [text, target] of cases) {
    assert.equal(classifySelection(text, { target }).action, 'translate', `${text} → ${target}`)
  }
})
