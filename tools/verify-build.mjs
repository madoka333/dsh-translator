/**
 * Build verification for dsh-translator: proves both bundles load, that the
 * browser bundle registers exactly one module factory with no leftover JSX, and
 * that the host bundle's public surface and config validation behave.
 *
 * Run by `npm run verify`; also safe to run on its own after a build.
 *
 * @module dsh-translator/tools/verify-build
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

// --- browser bundle -------------------------------------------------------
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(clientSource, /^window\.__ModuleLoader__\.load\(\{ id: "dsh-translator", factory: \(require\) =>/, 'client bundle must open with the registration')
assert.match(clientSource, /return module\.exports;\s*\} \}\);\s*$/, 'client bundle must close the registration')
assert.equal(
  (clientSource.match(/__ModuleLoader__\.load\(/g) ?? []).length,
  1,
  'exactly one registration',
)
const leftoverJsx = clientSource.match(/<[A-Za-z][\w.]*[\s>]/g) ?? []
assert.equal(leftoverJsx.length, 0, `bundle still contains JSX: ${leftoverJsx.slice(0, 3).join(', ')}`)

// The bundle must COMPILE, not merely exist. dsh's web boot treats an entry whose
// module fails to import as "did not activate" and throws, so an unparseable client
// bundle does not degrade this plugin — it leaves the whole Web GUI on the boot
// screen. That is not hypothetical: a backtick inside the CSS template literal's
// comment terminated the literal early, the bundle stopped parsing, and the app died
// at boot. `new Function` compiles the source without running it, which is exactly
// the check that was missing.
try {
  // eslint-disable-next-line no-new-func -- compiling IS the assertion
  new Function(clientSource)
} catch (error) {
  assert.fail(`lib/client.js does not compile, so dsh web boot would fail: ${error.message}`)
}

let registration
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      registration = value
    },
  },
}
await import(new URL('../lib/client.js', import.meta.url).href)
assert.equal(registration?.id, 'dsh-translator')
const requiredExternals = []
const clientExports = registration.factory((specifier) => {
  requiredExternals.push(specifier)
  if (specifier === 'react') return { createElement: () => null, Fragment: {} }
  if (specifier === 'react-dom') return { createPortal: () => null }
  if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
  throw new Error(`unexpected external require: ${specifier}`)
})
assert.ok(requiredExternals.every((specifier) => specifier.startsWith('react')), 'only react externals are requested eagerly')
for (const name of ['apply', 'inject']) {
  assert.ok(name in clientExports, `client bundle must export ${name}`)
}
assert.ok(Array.isArray(clientExports.inject))
// A hard `inject` list is a loaded gun pointed at web boot: dsh's client boot
// THROWS when any loader entry is still pending on a service, so one renamed
// service in one plugin blanks the whole Web GUI. Every capability is waited for
// in its own child fiber instead (see src/client/index.jsx's `inject` doc).
assert.deepEqual(clientExports.inject, [], 'the browser half must declare no hard service dependency')
assert.deepEqual(clientExports.SIDEBAR_SERVICES, ['slots', 'sidebarRight', 'sidebarRightTabs'])
assert.deepEqual(clientExports.SETTINGS_SERVICES, ['slots'])
assert.equal(clientExports.SESSION_SCOPE_SERVICE, 'uiSession')
// `guide[].id` is REQUIRED as of 0.1.7 (ui-sidebar-right rejects colliding entry
// ids, and two absent ids collide). The bundle is checked here too because the
// registration runs in the browser, where a throw is invisible to this build.
assert.match(clientSource, /guide:\s*\[/, 'the tab type must ship a guide entry')
assert.match(
  clientSource,
  /id:\s*TAB_ID/,
  'the guide entry must carry a stable id (0.1.7 rejects colliding guide ids)',
)

// --- host bundle ----------------------------------------------------------
const host = await import(new URL('../lib/index.js', import.meta.url).href)
assert.equal(host.name, 'dsh-translator')
assert.deepEqual(host.inject, ['webServer', 'llm', 'systemPrompt'])
// Every public name of the SOURCE entry must exist in the BUILT entry, which is what
// `package.json`'s `main` points at. That list used to be hand-written and had lost
// three names (PROBE_MARKER, injectDebugProbe, TRANSLATOR_GUIDANCE), so a consumer of
// the built entry saw `undefined` where the source had an export.
const hostSource = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8')
const declaredHostExports = [
  ...hostSource.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm),
].map((match) => match[1])
assert.ok(declaredHostExports.length >= 8, 'the host entry exports its public surface')
for (const name of declaredHostExports) {
  assert.ok(name in host, `the built host bundle must re-export ${name}`)
}
for (const name of ['apply', 'resolveConfig', 'resolveRoute', 'translateStream']) {
  assert.equal(typeof host[name], 'function', `host must export ${name}`)
}
// The profile loader validates config through the standard-schema `~standard`
// contract; the hand-rolled `Config` this plugin used to export could not
// satisfy it, and that mismatch failed the entire plugin tree at boot. It must
// not come back — validation lives in `resolveConfig`, called from `apply`.
assert.equal('Config' in host, false, 'host must not export a Config schema')

const defaults = host.resolveConfig({})
assert.equal(defaults.targetLanguage, 'zh-CN')
assert.equal(defaults.sourceLanguage, 'auto', 'the source defaults to detection')
assert.equal(defaults.mode, 'general', 'the default gear')
assert.equal(defaults.customInstruction, '')
assert.equal(defaults.timeoutMs, 30_000)
assert.equal(defaults.maxOutputTokens, 4096)
assert.equal(defaults.cacheSize, 500)
assert.equal(defaults.verbose, false)
assert.equal(defaults.reasoningEffort, undefined, 'reasoning effort is not silently implied by a logging flag')

const override = host.resolveConfig({ targetLanguage: 'ja', timeoutMs: 5_000, verbose: true })
assert.equal(override.targetLanguage, 'ja')
assert.equal(override.timeoutMs, 5_000)
assert.equal(override.verbose, true)

/** Every rejection the config surface owes the profile loader. */
const rejections = [
  [{ nope: 1 }, /unknown config key/],
  [{ provider: 'x' }, /must be supplied together/],
  [{ model: 'x' }, /must be supplied together/],
  [{ timeoutMs: 10 }, /timeoutMs must be an integer/],
  [{ maxOutputTokens: 1 }, /maxOutputTokens must be an integer/],
  [{ cacheSize: -1 }, /cacheSize must be an integer/],
  [{ verbose: 'yes' }, /verbose must be a boolean/],
  [{ targetLanguage: '' }, /targetLanguage must be a non-empty string/],
  [{ mode: 'nonsense' }, /not a known translation mode/],
  [{ sourceLanguage: 'nonsense' }, /is not a known language code/],
  [{ sourceLanguage: 'en', targetLanguage: 'en' }, /must differ/],
  [{ customInstruction: 'x'.repeat(401) }, /at most 400 characters/],
]
for (const [value, pattern] of rejections) {
  assert.throws(() => host.resolveConfig(value), pattern, `config ${JSON.stringify(value)} must be rejected`)
}

// `apply` must be exercised against the BUILT bundle, not the staged source the
// unit tests import. The two disagree exactly where the bundle's inner module
// table is concerned: a `require` that yields a promise binds every destructured
// import to `undefined`, which stays invisible until a value is finally used —
// `new LruCache(...)` then throws "is not a constructor" and the whole host dies
// at boot. Running apply here is what makes that failure a build failure.
const mounted = []
const taps = []
host.apply(
  {
    effect(factory) {
      factory()
      return () => {}
    },
    get: () => undefined,
    webServer: {
      register(route) {
        mounted.push(route)
        return () => {}
      },
      // The host diagnostic probe claims this seat; a real webServer provides it
      // (dsh-whale-widget uses the same one), so the fake must too or `apply`
      // throws and a working build looks broken.
      tapIndex(transform) {
        taps.push(transform)
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {} },
  },
  {},
)
assert.equal(mounted.length, 1, 'apply must register exactly one route')
assert.equal(mounted[0].path, '/dsh-translator')
assert.equal(typeof mounted[0].handler, 'function', 'the registered route must carry a handler')
assert.equal(taps.length, 1, 'apply must claim exactly one index tap for the host probe')
const probed = taps[0]('<html><body></body></html>')
// Compared by code point rather than by `includes`: this assertion exists to prove
// the probe reaches the page, and a literal comparison inside THIS file has twice
// refused a marker that the same call provably emits (the string it prints as
// "missing" plainly contains it). Contrasting the expected and actual sequences
// makes any drift readable instead of mysterious.
const marker = 'dsh-translator-host-probe'
const actualMarker = probed.slice(
  probed.indexOf('/*') + 2,
  probed.indexOf('*/', probed.indexOf('/*') + 2),
).trim()
const sameSequence = [...marker].every((ch, index) => ch === actualMarker[index]) && marker.length === actualMarker.length
assert.ok(
  sameSequence,
  `the host probe must carry ${JSON.stringify(marker)} in its banner; got ${JSON.stringify(actualMarker)}`,
)
assert.ok(probed.includes('</body>'), 'the probe stays inside the document body')

// --- package wiring -------------------------------------------------------
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(pkg.dsh.client.platform, 'web')
assert.equal(pkg.main, 'lib/index.js')
assert.equal(pkg.exports['./client'], './lib/client.js')

console.log('verify-build: client bundle, host bundle, apply mounting, config validation, and package wiring all OK')
