/**
 * Host-half integration test: mounts the real plugin on a fake cordis context and
 * drives the HTTP route end to end — SSE framing, loopback fence, method check,
 * route resolution, provider replay, and the server-side cache.
 *
 * The fake context is deliberately minimal: `webServer.register`, `systemPrompt
 * .section`, and `ctx.get('llm')` are the only seams the host half touches.
 *
 * @module dsh-translator/test/host.test
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { PROBE_MARKER, apply, resolveRoute, translateStream } from '../src/host/index.js'

/** A fake `IncomingMessage`. */
class FakeRequest extends EventEmitter {
  /**
   * @param body - raw request body.
   * @param options - `{method, url, host}`.
   */
  constructor(body, options = {}) {
    super()
    this.method = options.method ?? 'POST'
    this.url = options.url ?? '/dsh-translator/translate'
    this.headers = { host: options.host ?? '127.0.0.1:3080' }
    this.body = body
  }
}

/** A fake `ServerResponse` capturing status, headers, and body. */
class FakeResponse {
  status = 0
  headers = {}
  chunks = []
  writableEnded = false

  /** @param status - HTTP status. @param headers - response headers. */
  writeHead(status, headers) {
    this.status = status
    this.headers = headers ?? {}
    return this
  }

  /** @param chunk - one body chunk. */
  write(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk))
    return true
  }

  /** @param chunk - the final body chunk, when the writer passes one (Node accepts both). */
  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk))
    this.writableEnded = true
  }

  /** @returns the response body. */
  get body() {
    return this.chunks.join('')
  }

  /** @returns the parsed SSE frames. */
  get frames() {
    return this.body
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data:'))
      .map((block) => JSON.parse(block.slice(5).trim()))
  }
}

/**
 * Deliver one request to a handler and resolve with the response.
 *
 * The body is emitted from a macrotask: Node only delivers `data`/`end` once the
 * handler has attached its listeners, and the handler attaches them inside an
 * async step.
 */
async function call(handler, request) {
  const response = new FakeResponse()
  setTimeout(() => {
    request.emit('data', Buffer.from(request.body))
    request.emit('end')
  }, 0)
  const handled = Promise.resolve(handler(request, response))
  for (let attempt = 0; attempt < 500 && !response.writableEnded; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  await handled
  return response
}

/** Build a fake host context with one recording LLM adapter. */
function makeHost({ models = [{ id: 'deepseek-v4-flash' }], chunks = null, fail = null } = {}) {
  const registered = []
  const sections = []
  const taps = []
  const calls = []
  const selection = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const ctx = {
    effect(factory) {
      factory()
      return () => {}
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => selection }
      return undefined
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
      /** The host probe injects its script through the index tap. */
      tapIndex(transform) {
        taps.push(transform)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
  }
  ctx.get = (name) => {
    if (name === 'agentDefaultModel') return { currentSelection: () => selection }
    if (name !== 'llm') return undefined
    return {
      listModels: (provider) => (provider === 'deepseek-official' ? models : []),
      listProviders: () => [{ id: 'deepseek-official' }],
      stream(options) {
        calls.push(options)
        if (fail !== null) return (async function* () { throw fail })()
        const script = chunks ?? [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '我先看' },
          { type: 'text-delta', index: 0, text: '仓库结构。' },
          { type: 'block-end', index: 0, block: { type: 'text', text: '我先看仓库结构。' } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
        return (async function* () {
          for (const chunk of script) yield chunk
        })()
      },
    }
  }
  return { ctx, registered, sections, taps, calls }
}

test('apply mounts the translate route, the prompt section, and the index probe', () => {
  const { ctx, registered, sections, taps } = makeHost()
  apply(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/dsh-translator')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'plugin:translator')
  assert.ok(sections[0].text.includes('不影响上下文') || sections[0].text.includes('不进入你的上下文'))
  assert.equal(taps.length, 1, 'the host probe must claim one index tap')
})

test('the injected probe is self-contained, guarded, and injected once', () => {
  // Self-contained on purpose: the tap is captured here rather than through
  // `makeHost`, so a failure in this test can only mean the probe itself.
  const taps = []
  const ctx = {
    effect(factory) {
      factory()
      return () => {}
    },
    get: () => undefined,
    webServer: {
      register: () => () => {},
      tapIndex(transform) {
        taps.push(transform)
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {} },
  }
  apply(ctx, {})
  assert.equal(taps.length, 1, 'the host probe must claim one index tap')

  const [tap] = taps
  const html = '<html><body><div id="app"></div></body></html>'
  const injected = tap(html)

  // Asserted against the exported constant rather than a retyped literal: a
  // literal here would silently drift from the marker the probe actually carries,
  // and the failure message would then be unreadable ("it IS in the text").
  assert.ok(
    injected.includes(PROBE_MARKER),
    `the probe carries its marker ${PROBE_MARKER}; first 200 chars: ${injected.slice(0, 200)}`,
  )
  assert.ok(injected.includes('dsht-debug'), 'and only reports when asked for')
  assert.ok(injected.indexOf('</body>') > injected.indexOf(PROBE_MARKER), 'it lands in the body')
  // The probe must not depend on the client bundle: it is plain ES5-ish script.
  assert.equal(/<script[^>]*src=/.test(injected), false, 'it is inline, not a fetched bundle')
  for (const needle of ['data-slot-error', 'data-sidebar-right-unavailable', 'dsht-pane', 'data-dsh-translator-ui']) {
    assert.ok(injected.includes(needle), `the probe inspects ${needle}`)
  }
  // Idempotent: a second render of the same page must not double-inject.
  assert.equal(tap(injected), injected, 'injecting twice is a no-op')
  assert.equal((injected.match(/dsht-translator-host-probe<\/script>/g) ?? []).length, 0)
})

test('the probe script is syntactically valid JavaScript', () => {
  const { ctx, taps } = makeHost()
  apply(ctx, {})
  const injected = taps[0]('<html><body></body></html>')
  const start = injected.indexOf('<script>') + '<script>'.length
  const end = injected.indexOf('</script>', start)
  const code = injected.slice(start, end)
  // The probe runs in the browser, so a syntax error would silently do nothing —
  // which is the exact failure mode it exists to diagnose. Parse it here.
  assert.doesNotThrow(() => new Function(code), 'the probe must parse')
})

test('apply rejects a half-configured route and unknown keys', () => {
  const { ctx } = makeHost()
  assert.throws(() => apply(ctx, { provider: 'x' }), /must be supplied together/)
  assert.throws(() => apply(ctx, { nope: 1 }), /unknown config key/)
})

test('health reports the resolved route', async () => {
  const { ctx, registered } = makeHost()
  apply(ctx, {})
  const handler = registered[0].handler
  const response = await call(handler, new FakeRequest('', { method: 'GET', url: '/dsh-translator/health' }))
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.llm, true)
  // The fake adapter serves only `deepseek-v4-flash`, so the session selection
  // (`deepseek-flash`) is not routable and the cheapest served model wins.
  assert.deepEqual(body.route, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('a non-loopback Host is refused before anything else happens', async () => {
  const { ctx, registered, calls } = makeHost()
  apply(ctx, {})
  const response = await call(
    registered[0].handler,
    new FakeRequest(JSON.stringify({ text: 'hello world' }), { host: 'evil.example.com' }),
  )
  assert.equal(response.status, 403)
  assert.equal(calls.length, 0)
})

test('a non-POST method is refused', async () => {
  const { ctx, registered } = makeHost()
  apply(ctx, {})
  const response = await call(
    registered[0].handler,
    new FakeRequest('', { method: 'GET', url: '/dsh-translator/translate' }),
  )
  assert.equal(response.status, 405)
})

test('an empty or oversized body is refused', async () => {
  const { ctx, registered } = makeHost()
  apply(ctx, {})
  const handler = registered[0].handler
  const empty = await call(handler, new FakeRequest(JSON.stringify({ text: '   ' })))
  assert.equal(empty.status, 400)
  const huge = await call(handler, new FakeRequest(JSON.stringify({ text: 'x'.repeat(9000) })))
  assert.equal(huge.status, 413)
})

test('translate streams start → deltas → done, in order, in the target language', async () => {
  const { ctx, registered, calls } = makeHost()
  apply(ctx, { targetLanguage: 'zh-CN' })
  const response = await call(
    registered[0].handler,
    new FakeRequest(JSON.stringify({ text: 'Let me check the repository layout first.', kind: 'reasoning' })),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  const frames = response.frames
  assert.equal(frames[0].type, 'start')
  assert.deepEqual(frames[0].route, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const deltas = frames.filter((frame) => frame.type === 'delta')
  assert.equal(deltas.map((frame) => frame.text).join(''), '我先看仓库结构。')
  assert.equal(frames.at(-1).type, 'done')

  // The request the provider actually received.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek-official')
  assert.equal(calls[0].model, 'deepseek-v4-flash')
  assert.equal(calls[0].messages.length, 1)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.equal(calls[0].messages[0].source.plugin, 'dsh-translator')
  assert.ok(calls[0].system.includes('简体中文'))
  assert.ok(calls[0].signal instanceof AbortSignal)
})

test('a repeated translation is served from the server-side cache without a new call', async () => {
  const { ctx, registered, calls } = makeHost()
  apply(ctx, {})
  const body = JSON.stringify({ text: 'Let me check the repository layout first.' })
  const first = await call(registered[0].handler, new FakeRequest(body))
  const second = await call(registered[0].handler, new FakeRequest(body))
  assert.equal(calls.length, 1, 'the second request must not reach the model')
  assert.equal(second.frames[0].cached, true)
  assert.equal(second.frames.at(-1).cached, true)
  assert.deepEqual(
    second.frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text).join(''),
    first.frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text).join(''),
  )
})

test('a different target language does not reuse the cached answer', async () => {
  const { ctx, registered, calls } = makeHost()
  apply(ctx, {})
  const text = 'Let me check the repository layout first.'
  await call(registered[0].handler, new FakeRequest(JSON.stringify({ text, lang: 'zh-CN' })))
  await call(registered[0].handler, new FakeRequest(JSON.stringify({ text, lang: 'ja' })))
  assert.equal(calls.length, 2)
  assert.ok(calls[1].system.includes('日本語'))
})

test('a provider failure becomes an error frame, not a hung response', async () => {
  const failure = Object.assign(new Error('quota exceeded'), { code: 'QUOTA' })
  const { ctx, registered } = makeHost({ fail: failure })
  apply(ctx, {})
  const response = await call(
    registered[0].handler,
    new FakeRequest(JSON.stringify({ text: 'Let me check the repository layout first.' })),
  )
  const last = response.frames.at(-1)
  assert.equal(last.type, 'error')
  assert.equal(last.code, 'QUOTA')
  assert.ok(last.message.includes('quota exceeded'))
})

test('an empty model answer is reported as EMPTY', async () => {
  const { ctx, registered } = makeHost({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  apply(ctx, {})
  const response = await call(
    registered[0].handler,
    new FakeRequest(JSON.stringify({ text: 'Let me check the repository layout first.' })),
  )
  assert.equal(response.frames.at(-1).code, 'EMPTY')
})

test('max-tokens truncation is surfaced as an error code', async () => {
  const chunks = [
    { type: 'text-delta', index: 0, text: '部分' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const { ctx, registered, calls } = makeHost({ chunks })
  apply(ctx, {})
  const response = await call(
    registered[0].handler,
    new FakeRequest(JSON.stringify({ text: 'Let me check the repository layout first.' })),
  )
  assert.equal(response.frames.at(-1).code, 'MAX_TOKENS')
  assert.equal(calls.length, 1)
})

test('resolveRoute skips a route the adapter does not serve', () => {
  const { ctx } = makeHost({ models: [{ id: 'deepseek-v4-flash' }] })
  // The session selection (deepseek-flash) is unavailable → fall back to the
  // candidate that the registry proves is served.
  const [route] = resolveRoute(ctx, { provider: undefined, model: undefined }, undefined)
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('resolveRoute keeps a routable session selection', () => {
  const { ctx } = makeHost({ models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-flash' }] })
  const [route] = resolveRoute(ctx, { provider: undefined, model: undefined }, undefined)
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('resolveRoute prefers an explicit per-request route', () => {
  const { ctx } = makeHost({ models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] })
  const [route] = resolveRoute(ctx, { provider: undefined, model: undefined }, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
})

test('resolveRoute reports no route when the llm service is absent', () => {
  const ctx = {
    effect: (factory) => {
      factory()
      return () => {}
    },
    get: () => undefined,
  }
  assert.deepEqual(resolveRoute(ctx, { provider: undefined, model: undefined }, undefined), [])
})

test('translateStream reports NO_LLM rather than throwing when the service is missing', async () => {
  const ctx = { get: () => undefined }
  const events = []
  for await (const event of translateStream(ctx, { provider: 'p', model: 'm', system: 's', input: 'i' }, {})) {
    events.push(event)
  }
  assert.deepEqual(events, [{ type: 'error', code: 'NO_LLM', message: 'dsh-translator: llm service unavailable' }])
})
