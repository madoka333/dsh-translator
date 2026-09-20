/**
 * dsh-translator — host half.
 *
 * Provides two things to the browser half:
 * 1. `POST /dsh-translator/translate` — streams a translation over SSE, produced
 *    by the harness LLM service (`ctx.llm.stream`) so the user's existing
 *    credential chain, proxy, retry and error taxonomy apply unchanged.
 * 2. `GET /dsh-translator/health` — route/llm diagnostics for the panel.
 *
 * Pure display layer: this plugin never appends a session event, never touches an
 * agent request, and never writes a translated token into the model's context.
 * The only durable state it owns is an in-process LRU of finished translations.
 *
 * The browser half is served by DSH's client module system from this package's
 * `dsh.client` declaration (see `./client`); nothing here injects markup.
 *
 * @module dsh-translator
 */

import { LruCache } from '../shared/cache.js'
import { createTranslateRoute, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_TIMEOUT_MS } from './routes.js'

/** Plugin name — matches the package name, the bundle id, and the client entry id. */
export const name = 'dsh-translator'

/** Services the host half needs; `webServer`, `llm`, `systemPrompt` all come from the base bundle. */
export const inject = ['webServer', 'llm', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 216

/** Route prefix. */
const PREFIX = '/dsh-translator'

/** Model chosen when neither the config nor the session selection names one. */
const FALLBACK_MODEL = 'deepseek-v4-flash'

/** Model-facing note: the model must not change its own language because of this plugin. */
export const TRANSLATOR_GUIDANCE =
  '本机已安装 dsh-translator 插件（Web GUI 的划选翻译）：用户用鼠标划选对话里的英文内容（Think 推理、中间步骤、任意片段）并点「译」后，译文会在右侧边栏「翻译」页签里实时显示。这是纯显示层翻译——译文不进入会话日志、不进入你的上下文，也不代表用户希望你换语言思考。因此：不要因为这个插件而改变你输出或推理的语言，也不要主动为内容附加译文，照原样作答即可。用户提到「翻译插件 / 划选翻译 / 译文 / 引用翻译」时指的就是本插件。'

/** Defaults for every configurable field (kept local: the config resolver must not
 * depend on another module's initialization order). */
const CONFIG_DEFAULTS = {
  provider: undefined,
  model: undefined,
  targetLanguage: 'zh-CN',
  timeoutMs: 30_000,
  maxOutputTokens: 4096,
  cacheSize: 500,
  verbose: false,
}

/** The config keys this plugin accepts; anything else is a wiring mistake. */
const CONFIG_KEYS = new Set(Object.keys(CONFIG_DEFAULTS))

/**
 * Validate untrusted plugin configuration.
 * @param value - the composed config object (may be empty).
 * @returns a detached, validated config.
 */
export function resolveConfig(value = {}) {
  if (value === null || typeof value !== 'object') throw new Error('dsh-translator: config must be an object')
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-translator: unknown config key "${key}"`)
  }
  // Start from the defaults, then copy ONLY supplied keys: an explicit
  // `undefined` (a profile patch that names the key without a value) must not
  // erase the default it stands for.
  const out = { provider: undefined, model: undefined }
  for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    const supplied = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
    out[key] = supplied === undefined ? fallback : supplied
  }
  if ((out.provider === undefined) !== (out.model === undefined)) {
    throw new Error('dsh-translator: config.provider and config.model must be supplied together')
  }
  if (out.provider !== undefined && (typeof out.provider !== 'string' || out.provider === '')) {
    throw new Error('dsh-translator: config.provider must be a non-empty string')
  }
  if (out.model !== undefined && (typeof out.model !== 'string' || out.model === '')) {
    throw new Error('dsh-translator: config.model must be a non-empty string')
  }
  if (typeof out.targetLanguage !== 'string' || out.targetLanguage === '') {
    throw new Error('dsh-translator: config.targetLanguage must be a non-empty string')
  }
  assertIntInRange('timeoutMs', out.timeoutMs, 1000, 600_000)
  assertIntInRange('maxOutputTokens', out.maxOutputTokens, 64, 64_000)
  assertIntInRange('cacheSize', out.cacheSize, 0, 10_000)
  if (typeof out.verbose !== 'boolean') throw new Error('dsh-translator: config.verbose must be a boolean')
  return out
}

/** Assert one integer field is inside its accepted range. */
function assertIntInRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`dsh-translator: config.${name} must be an integer in [${min}, ${max}]`)
  }
}

/**
 * Mount the routes and the prompt section.
 *
 * There is deliberately no `Config` export: the profile loader only validates
 * plugins that expose one, and it does so through the standard-schema
 * `~standard` contract that a hand-rolled schema cannot satisfy — a mismatch
 * there fails the entire plugin tree, not just this plugin. Validating here
 * instead keeps a bad deployment config contained to dsh-translator, and the
 * loud throw still surfaces at boot.
 *
 * @param ctx - host context carrying `webServer`, `llm`, `systemPrompt`.
 * @param config - untrusted deployment config, passed through verbatim.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)

  const cache = new LruCache(resolved.cacheSize)
  const llm = () => ctx.get('llm')
  const log = (line) => console.log(`[dsh-translator] ${line}`)

  const deps = {
    config: () => resolved,
    log,
    cache,
    llmAvailable: () => typeof llm()?.stream === 'function',
    resolveRoute: (preferred) => resolveRoute(ctx, resolved, preferred),
    stream: (request) => translateStream(ctx, request, resolved, log),
  }

  ctx.effect(
    () => ctx.webServer.register(createTranslateRoute({ prefix: PREFIX, deps })),
    'dsh-translator: translate route',
  )

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'plugin:translator',
        order: SECTION_ORDER,
        text: TRANSLATOR_GUIDANCE,
      }),
    'dsh-translator: prompt section',
  )

  // Host-side diagnostic probe, injected into the page itself.
  //
  // Everything else this plugin ships rides the CLIENT bundle, which is fetched
  // once per page load and can therefore be stale, blocked, or failing to
  // evaluate — precisely the situations where "the panel does not show anything"
  // cannot be told apart from "the pane does not render". This probe depends on
  // none of that: the host writes the script tag, the browser runs it, and it
  // inspects the DOM (including React's own `data-slot-error` marker) and reports
  // what it finds.
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => injectDebugProbe(html)),
    'dsh-translator: host debug probe',
  )
}

/** Marker so the probe is injected exactly once per rendered page. */
export const PROBE_MARKER = 'dsh-translator-host-probe'

/**
 * Add the diagnostic probe script to the index document.
 * @param html - the rendered index document.
 * @returns the document with the probe appended, or unchanged when it is already there.
 */
export function injectDebugProbe(html) {
  if (typeof html !== 'string' || html.includes(PROBE_MARKER)) return html
  // The marker goes into the script as a literal too: it is what makes a second
  // render idempotent, and a marker that only exists in an interpolation is a
  // marker that silently disappears the moment the probe text is edited.
  const body = DEBUG_PROBE_SCRIPT.replace('/* probe */', `/* ${PROBE_MARKER} */`)
  const tag = `<script>${body}</script>`
  return html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : `${html}\n${tag}`
}

/**
 * The probe runs only for `?dsht-debug=1` and writes its findings into a fixed
 * panel, so a screenshot is enough to report them. It knows nothing about the
 * plugin's internals beyond the DOM attributes this package renders.
 */
const DEBUG_PROBE_SCRIPT = `
/* probe */
(function () {
  try {
    var params = new URLSearchParams(location.search);
    if (params.get('dsht-debug') !== '1') return;
  } catch (e) { return; }

  var lines = [];
  function add(label, value) { lines.push(label + ' : ' + value); }
  var domErrors = [];
  window.addEventListener('error', function (event) {
    domErrors.push(String((event && (event.error || event.message)) || 'unknown'));
  });
  window.addEventListener('unhandledrejection', function (event) {
    domErrors.push('rejection: ' + String(event && event.reason));
  });

  function probe(tag) {
    lines.length = 0;
    add('probe', tag + ' | page loaded ' + new Date().toLocaleTimeString());
    add('bundle in page', window.__DSH_BOOT__ ? 'boot graph present' : 'NO __DSH_BOOT__');
    add('plugin nodes', document.querySelectorAll('[data-dsh-translator-ui]').length + ' (self-report/pill/pane)');
    add('style tag', document.getElementById('dsh-translator-style') ? 'yes' : 'NO');
    var err = document.querySelector('[data-slot-error]');
    add('slot error cell', err ? ('YES -> ' + err.getAttribute('data-slot-error')) : 'none');
    var unavailable = document.querySelector('[data-sidebar-right-unavailable]');
    add('no-viewer notice', unavailable ? 'YES (seat key mismatch)' : 'none');
    var pane = document.querySelector('.dsht-pane');
    add('pane in DOM', pane ? ('yes, text ' + (pane.textContent || '').slice(0, 40)) : 'NO');
    add('render errors', domErrors.length ? domErrors.slice(-2).join(' | ').slice(0, 300) : '(none captured)');
    var box = document.getElementById('${PROBE_MARKER}-box');
    if (!box) {
      box = document.createElement('pre');
      box.id = '${PROBE_MARKER}-box';
      box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483002;max-width:min(620px,80vw);max-height:56vh;overflow:auto;margin:0;padding:10px 12px;border:1px solid #679efe;border-radius:10px;background:#12161f;color:#e6ebf2;font:11px/1.6 ui-monospace,monospace;white-space:pre-wrap;box-shadow:0 8px 28px rgba(0,0,0,.5)';
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = 'dsh-translator 宿主探针 (host probe)\\n' + lines.join('\\n');
  }

  var ticks = 0;
  function loop() {
    probe('tick ' + ticks);
    ticks += 1;
    if (ticks < 40) setTimeout(loop, 750);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loop);
  else loop();
})();
`

/**
 * Resolve the provider/model route for one call, in priority order:
 * per-request override → explicit config → the Session's/default selection →
 * the cheapest known model. Every candidate is checked against the adapter's
 * registry, so a stale selection degrades instead of failing the request.
 * @param ctx - host context.
 * @param config - resolved plugin config.
 * @param preferred - `{provider, model}` from the browser, when it read one.
 * @returns a single-element array with the route, or an empty array when nothing resolves.
 */
export function resolveRoute(ctx, config, preferred) {
  const candidates = []
  if (isRoute(preferred)) candidates.push({ provider: preferred.provider, model: preferred.model })
  if (config.provider !== undefined && config.model !== undefined) {
    candidates.push({ provider: config.provider, model: config.model })
  }
  const selection = defaultSelection(ctx)
  if (isRoute(selection)) candidates.push({ provider: selection.provider, model: selection.model })
  candidates.push({ provider: 'deepseek-official', model: FALLBACK_MODEL })
  for (const candidate of candidates) {
    if (supportsModel(ctx, candidate)) return [candidate]
  }
  return []
}

/** Whether a value looks like a provider/model pair. */
function isRoute(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.provider === 'string' &&
    value.provider !== '' &&
    typeof value.model === 'string' &&
    value.model !== ''
  )
}

/** Read the harness default model selection, defensively (the service is optional). */
function defaultSelection(ctx) {
  try {
    return ctx.get('agentDefaultModel')?.currentSelection() ?? undefined
  } catch {
    return undefined
  }
}

/** Ask the adapter registry whether it serves one exact route. */
function supportsModel(ctx, route) {
  try {
    const service = llm$of(ctx)
    if (service === undefined) return false
    const models = service.listModels(route.provider)
    if (Array.isArray(models) && models.length > 0) {
      return models.some((entry) => entry?.id === route.model)
    }
    // No catalog (a gateway that declares nothing): trust the route.
    return service.listProviders().some((entry) => entry?.id === route.provider)
  } catch {
    // Registry unavailable — let the call itself produce the loud error.
    return true
  }
}

/** `ctx.get('llm')` without throwing. */
function llm$of(ctx) {
  try {
    return ctx.get('llm')
  } catch {
    return undefined
  }
}

/**
 * Stream one translation through the harness LLM service into normalized events.
 *
 * The service is a REGISTRY adapter: `stream()` yields raw `StreamChunk`s, and
 * assembly into blocks is the caller's job (the same contract
 * `dsh-session-title-llm` implements with `BlockAssembler`). Text is relayed as
 * it arrives so the panel can grow the answer live.
 *
 * @param ctx - host context.
 * @param request - provider, model, system, input, limits, cancellation.
 * @param config - resolved plugin config.
 * @param log - line logger.
 * @returns async iterable of `{type:'delta'|'done'|'error', …}`.
 */
export async function* translateStream(ctx, request, config, log = () => {}) {
  const service = llm$of(ctx)
  if (service === undefined || typeof service.stream !== 'function') {
    yield { type: 'error', code: 'NO_LLM', message: 'dsh-translator: llm service unavailable' }
    return
  }

  const started = Date.now()
  let collected = ''
  try {
    if (request.signal?.aborted === true) throw new Error('dsh-translator: aborted before the call')
    const options = {
      provider: request.provider,
      model: request.model,
      messages: [userMessage(request.input)],
      system: request.system,
      maxTokens: request.maxTokens,
      signal: request.signal,
    }
    if (config.verbose) options.reasoningEffort = 'off'
    for await (const chunk of service.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        collected += chunk.text
        yield { type: 'delta', text: chunk.text }
        continue
      }
      if (chunk?.type === 'finish') {
        const reason = chunk.reason
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
          yield {
            type: 'error',
            code: reason.failure?.code ?? 'FAILED',
            message: reason.failure?.message ?? 'translation stream ended abnormally',
          }
          return
        }
        if (reason?.kind === 'max-tokens') {
          yield { type: 'error', code: 'MAX_TOKENS', message: 'dsh-translator: output truncated by maxTokens' }
          return
        }
      }
    }
    if (collected.trim() === '') {
      yield { type: 'error', code: 'EMPTY', message: 'dsh-translator: model produced no text' }
      return
    }
    if (config.verbose) {
      log(`translated ${[...request.input].length} chars → ${[...collected].length} chars in ${Date.now() - started}ms via ${request.provider}/${request.model}`)
    }
    yield { type: 'done', text: collected }
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'FAILED'
    const message = error instanceof Error ? error.message : String(error)
    if (request.signal?.aborted === true) yield { type: 'error', code: 'ABORTED', message }
    else yield { type: 'error', code, message }
  }
}

/** Build the one-shot user message for an auxiliary call, without a hard package edge. */
function userMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-translator' },
  }
}
