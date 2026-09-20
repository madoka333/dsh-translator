/**
 * Unit tests for the shared text policy: what the trigger should do with a
 * selection, which spans must never reach the model, and how a long selection is
 * cut into request-sized pieces.
 *
 * @module dsh-translator/test/select.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHUNK_CHARS,
  CODE_PLACEHOLDER,
  MAX_UNIT_CHARS,
  chunkText,
  cjkRatio,
  classifySelection,
  framingInput,
  languageLabel,
  looksChinese,
  looksLikeCodeLine,
  maskCode,
  normalizeSelection,
  restoreCode,
  translationSystemPrompt,
} from '../src/shared/select.js'

test('looksChinese: English prose is not Chinese', () => {
  assert.equal(looksChinese('Let me check the repository layout first.'), false)
  assert.equal(looksChinese('我把仓库结构先看一遍，再决定怎么改。'), true)
})

test('looksChinese: mixed text is judged by its dominant language', () => {
  // Mostly Chinese prose quoting a long model id: translating it is pointless,
  // and the identifier must not flip the verdict back to English.
  assert.equal(looksChinese('这个模型 deepseek-v4-flash 很快，我直接用它来翻译。'), true)
  // Mostly English with a Chinese term: still worth translating.
  assert.equal(looksChinese('I will run the tests with 命令 then check the output carefully.'), false)
  // A short Chinese phrase inside otherwise-English prose is not "already Chinese".
  assert.equal(looksChinese(`Let me check the repository layout first. 仓库结构`), false)
})

test('cjkRatio is measured over non-whitespace characters', () => {
  assert.equal(cjkRatio('中文'), 1)
  assert.equal(cjkRatio('中文           '), 1)
  assert.equal(cjkRatio('abc'), 0)
  assert.equal(cjkRatio(''), 0)
})

test('classifySelection: short selections never produce a trigger', () => {
  assert.equal(classifySelection('hi').action, 'ignore')
  assert.equal(classifySelection('   ').action, 'ignore')
  assert.equal(classifySelection('hmm ok').action, 'ignore')
})

test('classifySelection: English asks for a translation, Chinese explains instead', () => {
  assert.equal(classifySelection('Let me check the repository first.').action, 'translate')
  const chinese = classifySelection('我先看一下仓库结构，然后再决定改哪里。')
  assert.equal(chinese.action, 'noop')
  assert.equal(chinese.reason, 'already-chinese')
})

test('normalizeSelection collapses trailing space and blank-line runs', () => {
  assert.equal(normalizeSelection('  a \r\n\r\n\r\n b  '), 'a\n\n b')
})

test('looksLikeCodeLine: paths, commands, flags and URLs are code', () => {
  for (const line of [
    'C:\\work\\my-app\\src\\index.jsx',
    '/usr/local/bin/node',
    'npm run build --filter dsh-translator',
    'Set-Content lib/index.js -Value $c -NoNewline',
    'https://github.com/deepseek-ai/deepseek-harness',
    'pnpm add -D esbuild',
    '[label](https://example.com/x)',
  ]) {
    assert.equal(looksLikeCodeLine(line), true, line)
  }
})

test('looksLikeCodeLine: ordinary prose is not code', () => {
  for (const line of [
    'Let me check the repository layout first.',
    'The plan is to finish the sidebar pane before the tests.',
    '这是一段中文。',
  ]) {
    assert.equal(looksLikeCodeLine(line), false, line)
  }
})

test('maskCode replaces code lines and fenced blocks, and restoreCode puts them back', () => {
  const source = [
    'I will run this command:',
    '',
    'npm run build --filter dsh-translator',
    '',
    'then read the output.',
  ].join('\n')
  const masked = maskCode(source)
  assert.equal(masked.text.includes('npm run build'), false, 'the command never reaches the model')
  assert.equal(masked.text.includes(CODE_PLACEHOLDER), true)
  assert.deepEqual(masked.spans, ['npm run build --filter dsh-translator'])

  // A model that keeps the placeholder lets the original come back verbatim.
  const kept = restoreCode(masked.text, masked.spans)
  assert.equal(kept.includes(CODE_PLACEHOLDER), false)
  assert.equal(kept.includes('npm run build --filter dsh-translator'), true)
  assert.equal(kept.includes('then read the output.'), true)

  // A model that dropped it must not make the text disappear.
  const dropped = restoreCode('I will run a command, then read the output.', masked.spans)
  assert.equal(dropped, 'I will run a command, then read the output.')
})

test('maskCode drops whole fenced blocks when asked', () => {
  const source = 'Before\n```js\nconst a = 1\n```\nAfter'
  const masked = maskCode(source, { skipCodeFences: true })
  assert.equal(masked.text.includes('const a = 1'), false)
  assert.equal(masked.spans.length, 1)
  const kept = maskCode(source, { skipCodeFences: false })
  assert.equal(kept.text.includes('const a = 1'), true)
})

test('chunkText keeps order and reproduces the input modulo seams', () => {
  const paragraph = `${'sentence one. '.repeat(60)}end.`
  const chunks = chunkText(paragraph)
  assert.ok(chunks.length > 1, 'a long paragraph must split')
  for (const chunk of chunks) assert.ok([...chunk].length <= CHUNK_CHARS, chunk.length)
  // Joining the pieces reproduces the source once whitespace runs are normalized:
  // a seam may sit where a single space used to be.
  const flatten = (value) => normalizeSelection(value).replace(/\s+/g, '')
  assert.equal(flatten(chunks.join('')), flatten(paragraph), 'pieces preserve the text and its order')
})

test('chunkText hard-slices a punctuation-free run', () => {
  const run = 'x'.repeat(CHUNK_CHARS * 2 + 7)
  const chunks = chunkText(run)
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [CHUNK_CHARS, CHUNK_CHARS, 7],
  )
})

test('chunkText splits on Chinese sentence marks too', () => {
  const paragraph = '第一句话。第二句话！第三句话？'.repeat(40)
  const chunks = chunkText(paragraph)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok([...chunk].length <= CHUNK_CHARS)
})

test('chunkText returns [] for empty input and the text itself when short', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('  hello there  '), ['hello there'])
})

test('MAX_UNIT_CHARS is the documented cap', () => {
  assert.equal(MAX_UNIT_CHARS, 8000)
})

test('languageLabel accepts a code or a label and falls back to the input', () => {
  assert.equal(languageLabel('zh-CN'), '简体中文')
  assert.equal(languageLabel('简体中文'), '简体中文')
  assert.equal(languageLabel('ja'), '日本語')
  assert.equal(languageLabel('xx'), 'xx')
})

test('translationSystemPrompt states target and the code-placeholder rule', () => {
  const reasoning = translationSystemPrompt('简体中文', 'reasoning')
  assert.ok(reasoning.includes('简体中文'))
  assert.ok(reasoning.includes('reasoning'))
  assert.ok(reasoning.includes(CODE_PLACEHOLDER))
  const selection = translationSystemPrompt('English', 'selection')
  assert.ok(selection.includes('selected'))
})

test('framingInput frames kind and text as JSON so text cannot break delimiters', () => {
  const framed = framingInput('a "quote" and a\nnewline', 'text')
  assert.deepEqual(JSON.parse(framed), { kind: 'text', text: 'a "quote" and a\nnewline' })
})
