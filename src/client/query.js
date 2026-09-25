/**
 * dsh-translator client transport: POST one text unit to the host route and
 * relay its SSE frames to the caller.
 *
 * Runs every failure mode through one path so a card can always show something
 * actionable: a JSON error body, an `error` frame, a non-2xx status, a body that
 * is not an event stream, or a network/abort failure.
 *
 * @module dsh-translator/client/query
 */

/** Route prefix, mirroring the host half's `PREFIX`. */
const PREFIX = '/dsh-translator'

/** Retry budget for a request that produced NO output yet. */
const MAX_ATTEMPTS = 3

/** Backoff before attempt 2 and 3 (ms). */
const BACKOFF_MS = [500, 1500]

/** Error carrying the host's stable code so the card can label it. */
export class TranslateError extends Error {
  /**
   * @param message - human-readable failure.
   * @param code - stable machine code (`AUTH`, `QUOTA`, `TIMEOUT`, …).
   */
  constructor(message, code = 'FAILED') {
    super(message)
    this.name = 'TranslateError'
    this.code = code
  }
}

/** Sleep that settles early when the signal aborts. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new TranslateError('aborted', 'ABORTED'))
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Translate one text unit, streaming deltas to `onDelta`.
 *
 * The retry loop's index is deliberately NOT called `attempt`: the helper that
 * performs one request used to carry that name, the loop's `let attempt` shadowed
 * it inside the body, and `await attempt({…})` became a TypeError on a number —
 * so `fetch` was never reached and every card sat on "translating…" forever with
 * only a console error to show for it. Two names, two jobs.
 *
 * @param request - `{text, kind, lang, source?, mode?, instruction?, route?, signal, onStart, onDelta}`.
 * @returns the complete translated text.
 * @throws {TranslateError} when the host or the model failed.
 */
export async function translate(request) {
  let lastError
  for (let tryIndex = 0; tryIndex < MAX_ATTEMPTS; tryIndex += 1) {
    if (request.signal?.aborted === true) throw new TranslateError('aborted', 'ABORTED')
    let produced = false
    try {
      return await attemptOnce({
        ...request,
        markProduced: () => {
          produced = true
        },
      })
    } catch (error) {
      lastError = error
      const fatal =
        error instanceof TranslateError &&
        (error.code === 'ABORTED' ||
          error.code === 'AUTH' ||
          error.code === 'QUOTA' ||
          error.code === 'INVALID' ||
          error.code === 'NO_LLM' ||
          error.code === 'NO_ROUTE')
      // Retry only a pre-output failure: re-running after deltas arrive would
      // duplicate the visible answer.
      if (fatal || produced || tryIndex === MAX_ATTEMPTS - 1) break
      await delay(BACKOFF_MS[Math.min(tryIndex, BACKOFF_MS.length - 1)], request.signal)
    }
  }
  throw lastError ?? new TranslateError('translation failed', 'FAILED')
}

/** One attempt: request + stream consumption. */
async function attemptOnce(request) {
  const response = await fetch(`${PREFIX}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      text: request.text,
      kind: request.kind,
      lang: request.lang,
      // The effective source (`null`/`'auto'` = "you decide"), the gear, and the
      // custom gear's own text. All three are re-sanitized by the host.
      ...(request.source === undefined || request.source === null ? {} : { source: request.source }),
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.instruction === undefined || request.instruction === '' ? {} : { instruction: request.instruction }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.route === undefined ? {} : { route: request.route }),
    }),
    signal: request.signal,
  })

  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'AUTH' : `HTTP_${response.status}`
    throw new TranslateError(`${response.status} ${await safeText(response)}`, code)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || response.body === null) {
    // A JSON error body can still arrive with a 200 from a proxy.
    const text = await safeText(response)
    throw new TranslateError(text.slice(0, 400) || 'unexpected response body', 'INVALID')
  }

  let assembled = ''
  for await (const frame of readSse(response.body, request.signal)) {
    if (frame.type === 'start') {
      request.onStart?.({
        label: frame.route === undefined ? '' : `${frame.route.provider}/${frame.route.model}`,
        cached: frame.cached === true,
      })
      continue
    }
    if (frame.type === 'delta') {
      request.markProduced()
      assembled += frame.text
      request.onDelta?.(frame.text)
      continue
    }
    if (frame.type === 'error') throw new TranslateError(frame.message || 'translation failed', frame.code || 'FAILED')
    if (frame.type === 'done') return assembled
  }
  if (assembled === '') throw new TranslateError('the translation stream ended without output', 'EMPTY')
  return assembled
}

/** Read a Response body, yielding parsed SSE frames. */
async function* readSse(body, signal) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  const stream = new SseFramer()
  try {
    for (;;) {
      if (signal?.aborted === true) throw new TranslateError('aborted', 'ABORTED')
      const { value, done } = await reader.read()
      if (done === true) break
      for (const frame of stream.push(decoder.decode(value, { stream: true }))) yield frame
    }
    for (const frame of stream.flush()) yield frame
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Incremental `text/event-stream` splitter: feed it whatever the network hands
 * over — including a frame cut in half — and it yields only complete payloads.
 * Exported so the framing rules are unit-testable without a server.
 */
export class SseFramer {
  #buffer = ''

  /**
   * @param chunk - one decoded network chunk.
   * @returns every payload completed by this chunk, in order.
   */
  push(chunk) {
    this.#buffer += chunk
    const frames = []
    for (;;) {
      // Tolerate CRLF separators as well as LF: both appear in the wild.
      const match = /\r?\n\r?\n/.exec(this.#buffer)
      if (match === null) return frames
      const raw = this.#buffer.slice(0, match.index)
      this.#buffer = this.#buffer.slice(match.index + match[0].length)
      const parsed = parseFrame(raw)
      if (parsed !== undefined) frames.push(parsed)
    }
  }

  /**
   * @returns the payload left in the buffer once the stream ended (a server that
   *   omitted the final blank line still delivers its last frame).
   */
  flush() {
    const parsed = parseFrame(this.#buffer)
    this.#buffer = ''
    return parsed === undefined ? [] : [parsed]
  }
}

/** Parse one SSE frame block into a payload object. */
export function parseFrame(rawBlock) {
  const lines = String(rawBlock).split(/\r?\n/)
  const dataLines = []
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    else if (line.startsWith('data')) dataLines.push(line.slice(4))
  }
  if (dataLines.length === 0) return undefined
  const payload = dataLines.join('\n')
  if (payload.trim() === '') return undefined
  try {
    const parsed = JSON.parse(payload)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Read a response body as text without throwing. */
async function safeText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
