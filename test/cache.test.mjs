/**
 * Unit tests for the bounded LRU and its composite key: the mechanism that keeps
 * a re-render or a repeated selection from costing another model call.
 *
 * @module dsh-translator/test/cache.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LruCache, translationKey } from '../src/shared/cache.js'

test('set/get round-trips a value', () => {
  const cache = new LruCache(4)
  cache.set('a', 'translated a')
  assert.equal(cache.get('a'), 'translated a')
  assert.equal(cache.get('missing'), undefined)
})

test('eviction drops the least recently used entry', () => {
  const cache = new LruCache(2)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  assert.equal(cache.has('a'), false, 'oldest entry evicted')
  assert.equal(cache.get('b'), 2)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.size, 2)
})

test('get refreshes recency so a hot entry survives', () => {
  const cache = new LruCache(2)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1) // 'a' becomes the most recently used
  cache.set('c', 3)
  assert.equal(cache.has('b'), false, 'b was the coldest')
  assert.equal(cache.has('a'), true)
})

test('re-setting a key refreshes it instead of duplicating', () => {
  const cache = new LruCache(2)
  cache.set('a', 1)
  cache.set('a', 2)
  assert.equal(cache.size, 1)
  assert.equal(cache.get('a'), 2)
})

test('a limit of zero still retains one entry rather than throwing', () => {
  const cache = new LruCache(0)
  cache.set('a', 1)
  assert.equal(cache.size, 1)
  assert.equal(cache.get('a'), 1)
})

test('clear empties the cache', () => {
  const cache = new LruCache(3)
  cache.set('a', 1)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('translationKey separates provider, model, language and source', () => {
  const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const base = translationKey('hello', '简体中文', route)
  assert.notEqual(base, translationKey('hello', '日本語', route), 'language matters')
  assert.notEqual(
    base,
    translationKey('hello', '简体中文', { provider: 'other', model: 'deepseek-v4-flash' }),
    'provider matters',
  )
  assert.notEqual(
    base,
    translationKey('hello', '简体中文', { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    'model matters',
  )
  assert.notEqual(base, translationKey('hello there', '简体中文', route), 'source matters')
  assert.equal(base, translationKey('hello', '简体中文', route), 'identical inputs collide on purpose')
})

test('translationKey tolerates a missing route', () => {
  assert.equal(typeof translationKey('x', '简体中文', undefined), 'string')
})

test('translationKey separates the gear, the source hint and the custom requirement', () => {
  const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const base = translationKey('hello', '简体中文', route, { mode: 'general', source: 'en' })
  assert.notEqual(base, translationKey('hello', '简体中文', route, { mode: 'academic', source: 'en' }), 'gear matters')
  assert.notEqual(base, translationKey('hello', '简体中文', route, { mode: 'general', source: 'ja' }), 'source matters')
  assert.notEqual(
    base,
    translationKey('hello', '简体中文', route, { mode: 'custom', source: 'en', style: 'keep it short' }),
    'the custom requirement matters',
  )
  assert.notEqual(
    translationKey('hello', '简体中文', route, { mode: 'custom', source: 'en', style: 'keep it short' }),
    translationKey('hello', '简体中文', route, { mode: 'custom', source: 'en', style: 'keep it formal' }),
    'editing the requirement must invalidate the answer',
  )
  assert.equal(base, translationKey('hello', '简体中文', route, { mode: 'general', source: 'en' }), 'same spec, same key')
  // The pre-beta.2 three-argument call is a DIFFERENT key from a gear-aware one:
  // that is fine (the host cache is in-process), and it must stay a string.
  assert.equal(typeof translationKey('hello', '简体中文', route), 'string')
})
