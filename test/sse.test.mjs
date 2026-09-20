/**
 * Unit tests for the SSE framer, the piece that decides whether a streamed
 * translation arrives complete and in order.
 *
 * @module dsh-translator/test/sse.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SseFramer, TranslateError, parseFrame } from '../src/client/query.js'

/** Build one wire frame. */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

test('parseFrame reads one data line', () => {
  assert.deepEqual(parseFrame('data: {"type":"done"}'), { type: 'done' })
})

test('parseFrame ignores comments and blank frames', () => {
  assert.equal(parseFrame(': keep-alive'), undefined)
  assert.equal(parseFrame(''), undefined)
  assert.equal(parseFrame('event: ping'), undefined)
})

test('parseFrame joins multiple data lines with a newline', () => {
  assert.deepEqual(parseFrame('data: {"a":\ndata: 1}'), { a: 1 })
})

test('parseFrame tolerates a missing space after the colon', () => {
  assert.deepEqual(parseFrame('data:{"type":"start"}'), { type: 'start' })
})

test('SseFramer yields frames as they complete and holds partial ones', () => {
  const framer = new SseFramer()
  assert.deepEqual(framer.push(frame({ type: 'start' })), [{ type: 'start' }])
  // A frame cut in half must not surface until its blank line arrives.
  assert.deepEqual(framer.push('data: {"type":"del'), [])
  assert.deepEqual(framer.push('ta","text":"你"}\n\n'), [{ type: 'delta', text: '你' }])
})

test('SseFramer handles several frames in one chunk and CRLF separators', () => {
  const framer = new SseFramer()
  const chunk = `${frame({ type: 'start' })}${frame({ type: 'delta', text: 'a' })}`.replace(/\n\n/g, '\r\n\r\n')
  const frames = framer.push(chunk)
  assert.equal(frames.length, 2)
  assert.equal(frames[1].text, 'a')
})

test('SseFramer flush delivers a last frame with no trailing blank line', () => {
  const framer = new SseFramer()
  assert.deepEqual(framer.push('data: {"type":"done"}'), [])
  assert.deepEqual(framer.flush(), [{ type: 'done' }])
})

test('SseFramer reassembles a multi-byte character split across chunks', () => {
  const framer = new SseFramer()
  const body = Buffer.from(frame({ type: 'delta', text: '翻译' }), 'utf8')
  const decoder = new TextDecoder()
  const frames = []
  for (let index = 0; index < body.length; index += 1) {
    frames.push(...framer.push(decoder.decode(body.subarray(index, index + 1), { stream: true })))
  }
  frames.push(...framer.flush())
  assert.deepEqual(frames, [{ type: 'delta', text: '翻译' }])
})

test('TranslateError carries the host code', () => {
  const error = new TranslateError('quota exceeded', 'QUOTA')
  assert.equal(error.code, 'QUOTA')
  assert.equal(error.name, 'TranslateError')
})
