/**
 * dsh-translator host routes: the SSE translation endpoint, a health probe, and
 * the client-panel script the page loads.
 *
 * Design notes:
 * - The route owns the whole response lifecycle, which is what makes the long
 *   SSE connection legal here (see `WebRoute.handler`).
 * - Loopback-only `Host` check: the same DNS-rebinding fence the official API
 *   and dsh-plugin-clinic use. It is a reachability policy, not authentication.
 * - Translation goes through the harness LLM service (`ctx.llm.stream`), so the
 *   user's existing credential chain, proxy, timeouts and error taxonomy apply
 *   and nothing has to be configured twice.
 *
 * @module dsh-translator/host/routes
 */

import {
  MAX_UNIT_CHARS,
  framingInput,
  languageLabel,
  normalizeSelection,
  translationSystemPrompt,
} from '../shared/select.js'
import { translationKey } from '../shared/cache.js'

/** Loopback authorities; port optional. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu

/** Request body cap (bytes). One 8000-char unit with JSON escaping fits easily. */
const MAX_BODY_BYTES = 32 * 1024

/** Default wall-clock budget for one translation call. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default output cap: a translation is never longer than its input, in tokens. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

/**
 * Create the translation route definition.
 * @param options - the running plugin's deps.
 * @param options.prefix - route prefix, e.g. `/dsh-translator`.
 * @param options.deps - host deps: `llm`, `resolveRoute`, `config`, `log`.
 * @returns the `WebRoute`-shaped prefix registration.
 */
export function createTranslateRoute({ prefix, deps }) {
  return {
    kind: 'prefix',
    path: prefix,
    handler: (req, res) => {
      void handleTranslate(req, res, deps)
    },
  }
}

/**
 * Handle one request under the prefix: POST …/translate, GET …/health.
 * @param req - incoming request.
 * @param res - response the handler owns.
 * @param deps - host deps.
 */
async function handleTranslate(req, res, deps) {
  const host = req.headers.host ?? ''
  if (!LOOPBACK_HOST.test(host)) {
    writeJson(res, 403, { ok: false, error: 'dsh-translator: loopback host required' })
    return
  }

  const url = new URL(req.url ?? '/', `http://${host}`)
  if (url.pathname.endsWith('/health')) {
    writeJson(res, 200, {
      ok: true,
      llm: deps.llmAvailable(),
      route: deps.resolveRoute()[0] ?? null,
    })
    return
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'dsh-translator: POST required' })
    return
  }

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `dsh-translator: ${messageOf(error)}` })
    return
  }

  const text = normalizeSelection(payload?.text)
  if (text === '') {
    writeJson(res, 400, { ok: false, error: 'dsh-translator: text is required' })
    return
  }
  if ([...text].length > MAX_UNIT_CHARS) {
    writeJson(res, 413, { ok: false, error: `dsh-translator: text exceeds ${MAX_UNIT_CHARS} characters` })
    return
  }
  if (!deps.llmAvailable()) {
    writeJson(res, 503, { ok: false, error: 'dsh-translator: llm service unavailable' })
    return
  }

  const [route] = deps.resolveRoute(payload?.route)
  if (route === undefined) {
    writeJson(res, 503, {
      ok: false,
      error: 'dsh-translator: no llm route resolved — configure `provider`/`model` in the plugin config',
    })
    return
  }

  const kind = payload?.kind === 'reasoning' || payload?.kind === 'text' ? payload.kind : 'selection'
  const target = languageLabel(payload?.lang ?? deps.config().targetLanguage)
  const cached = deps.cache.get(translationKey(text, target, route))
  if (cached !== undefined) {
    writeCachedSse(res, route, cached)
    return
  }

  await streamTranslation({ req, res, deps, text, kind, target, route })
}

/**
 * Stream one translation: write SSE headers, then relays `ctx.llm.stream` text
 * deltas. Aborts the model call when the browser disconnects, so a cancelled
 * card stops costing tokens.
 */
async function streamTranslation({ req, res, deps, text, kind, target, route }) {
  const controller = new AbortController()
  const timeoutMs = deps.config().timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(new Error('dsh-translator: timeout')), timeoutMs)
  let clientGone = false
  const onClose = () => {
    clientGone = true
    controller.abort(new Error('dsh-translator: client disconnected'))
  }
  req.on('close', onClose)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  sse(res, { type: 'start', route, target })

  let collected = ''
  try {
    const stream = deps.stream({
      provider: route.provider,
      model: route.model,
      system: translationSystemPrompt(target, kind),
      input: framingInput(text, kind),
      maxTokens: deps.config().maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    })
    for await (const event of stream) {
      if (event.type === 'delta') {
        collected += event.text
        sse(res, { type: 'delta', text: event.text })
        continue
      }
      if (event.type === 'error') {
        sse(res, { type: 'error', code: event.code ?? 'UNKNOWN', message: event.message ?? '' })
        res.end()
        return
      }
    }
    if (collected.trim() === '') {
      sse(res, { type: 'error', code: 'EMPTY', message: 'dsh-translator: model produced no text' })
      res.end()
      return
    }
    deps.cache.set(translationKey(text, target, route), collected)
    sse(res, { type: 'done', chars: [...collected].length })
    res.end()
  } catch (error) {
    const aborted = controller.signal.aborted
    if (aborted && clientGone) {
      // The browser went away: nothing to report to.
      if (!res.writableEnded) res.end()
      return
    }
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : aborted ? 'TIMEOUT' : 'FAILED'
    deps.log(`translate failed: ${code}: ${messageOf(error)}`)
    if (!res.writableEnded) {
      sse(res, { type: 'error', code, message: messageOf(error) })
      res.end()
    }
  } finally {
    clearTimeout(timer)
    req.off('close', onClose)
  }
}

/** Replay a cached translation as the same SSE shape the client already parses. */
function writeCachedSse(res, route, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  sse(res, { type: 'start', route, cached: true })
  sse(res, { type: 'delta', text })
  sse(res, { type: 'done', chars: [...text].length, cached: true })
  res.end()
}

/** Write one SSE frame. */
function sse(res, payload) {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** Read and parse a bounded JSON body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${messageOf(error)}`))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Error → message, without ever throwing. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
