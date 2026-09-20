/**
 * dsh-translator build: bundle `src/client/index.jsx` into `lib/client.js` as a
 * browser client-bundle registration — with no bundler dependency and no child
 * process.
 *
 * Why a hand-rolled bundler: this project builds inside a sandbox that forbids
 * spawning a helper process, and the client graph is ~10 small local modules plus
 * two externals. The JSX subset is tiny and `build-jsx.mjs` transforms it
 * directly, so the whole build is plain Node — no esbuild binary, no TypeScript
 * install, nothing to keep in sync with the platform.
 *
 * Output contract (identical to the proven dsh-skill-picker bundle): the body is
 * a module table wrapped in
 * `window.__ModuleLoader__.load({ id, factory: (require) => { var module = … } })`.
 * `react` / `react-dom/client` / `@deepseek-ai/*` stay EXTERNAL — they come from
 * the browser module table at runtime.
 *
 * `node build.mjs --stage` additionally mirrors the transformed sources into
 * `.build-run/` so the Node smoke test can import the very same graph.
 *
 * @module dsh-translator/build
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformJsx } from './build-jsx.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PKG = 'dsh-translator'
const ENTRY = path.join(ROOT, 'src/client/index.jsx')
const OUT = path.join(ROOT, 'lib/client.js')
const STAGE = path.join(ROOT, '.build-run')

/** Bare specifiers the browser module table provides. */
const EXTERNAL_PREFIXES = ['react', 'react-dom', '@deepseek-ai/']

/** Whether a require specifier is resolved at runtime instead of bundled. */
function isExternal(spec) {
  return EXTERNAL_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(prefix))
}

/** Read + transform one source file (JSX in, CommonJS out). */
async function readModule(file) {
  const raw = await readFile(file, 'utf8')
  const source = file.endsWith('.jsx') ? transformJsx(raw, path.relative(ROOT, file)) : raw
  return transpileImports(source, path.relative(ROOT, file))
}

/**
 * Render one `require(…)` + destructuring pair for an import clause.
 * @param kind - 'namespace' | 'named' | 'default'.
 * @param clause - the import clause without the `from` keyword.
 * @param specifier - the module specifier as written.
 * @param id - the generated binding for the required module.
 * @returns the CommonJS statements replacing the import.
 */
function renderImport(kind, clause, specifier, id) {
  const spec = normalizeSpecifier(specifier)
  const head = `const ${id} = require(${JSON.stringify(spec)});`
  if (kind === 'namespace') {
    const local = clause.replace(/^\*\s+as\s+/, '').trim()
    return `${head}\nconst ${local} = ${id};`
  }
  if (kind === 'named') {
    const names = clause
      .slice(1, -1)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    const pairs = names.map((entry) => {
      const parts = entry.split(/\s+as\s+/).map((part) => part.trim())
      return parts.length === 2 ? `${JSON.stringify(parts[0])}: ${parts[1]}` : parts[0]
    })
    return `${head}\nconst { ${pairs.join(', ')} } = ${id};`
  }
  const local = clause.trim()
  // A default import of an interop module (a DSH package built as CJS) keeps the
  // namespace when it carries no `default` member of its own.
  return `${head}\nconst ${local} = ${id}.__esModule === true && ${id}.default !== undefined ? ${id}.default : ${id};`
}

/**
 * Rewrite ESM import/export syntax into the CommonJS shape the module table
 * consumes, and normalize relative specifiers.
 *
 * One pass over import statements (so an already-rewritten `require` can never be
 * matched again), then one pass over export declarations. Anything outside the
 * supported forms throws with the offending line.
 */
function transpileImports(source, name) {
  const requires = []
  let counter = 0
  const nextId = (specifier) => {
    const id = `__imp${counter}`
    counter += 1
    if (!isExternal(specifier) && !specifier.startsWith('.')) {
      throw new Error(`dsh-translator build: unexpected bare import "${specifier}" in ${name}`)
    }
    return id
  }

  const importPattern = /^[ \t]*import\s+(?:type\s+)?((?:\*\s+as\s+[A-Za-z_$][\w$]*)|(?:\{[^}]*\})|(?:[A-Za-z_$][\w$]*))?\s*(?:,\s*(\{[^}]*\}))?\s*from\s*(['"])([^'"]+)\3\s*;?[ \t]*$/gm

  let body = source.replace(importPattern, (match, clause, extraNamed, quote, specifier) => {
    const parts = []
    const primary = (clause ?? '').trim()
    if (primary !== '') {
      if (primary.startsWith('*')) parts.push(renderImport('namespace', primary, specifier, nextId(specifier)))
      else if (primary.startsWith('{')) parts.push(renderImport('named', primary, specifier, nextId(specifier)))
      else parts.push(renderImport('default', primary, specifier, nextId(specifier)))
    }
    if (extraNamed !== undefined && extraNamed.trim() !== '') {
      parts.push(renderImport('named', extraNamed.trim(), specifier, nextId(specifier)))
    }
    return parts.join('\n')
  })

  body = body.replace(/^[ \t]*import\s+(["'])([^'"]+)\1\s*;?[ \t]*$/gm, (match, quote, specifier) => {
    const id = nextId(specifier)
    requires.push(`const ${id} = require(${JSON.stringify(normalizeSpecifier(specifier))});`)
    return ''
  })

  // export const/let/var/function/class (including async functions)
  const named = []
  body = body.replace(
    /^[ \t]*export\s+(async\s+)?(function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    (match, asyncWord, kind, identifier) => {
      named.push(identifier)
      return `${asyncWord ?? ''}${kind} ${identifier}`
    },
  )

  // export { a, b as c }
  body = body.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (match, clause) => {
    for (const entry of clause.split(',')) {
      const trimmed = entry.trim()
      if (trimmed === '') continue
      const parts = trimmed.split(/\s+as\s+/).map((part) => part.trim())
      named.push(parts.length === 2 ? `${parts[0]}: ${parts[1]}` : trimmed)
    }
    return ''
  })

  // export default …
  const hadDefault = /^[ \t]*export\s+default\s+/m.test(body)
  if (hadDefault) body = body.replace(/^[ \t]*export\s+default\s+/m, 'const __default = ')
  if (hadDefault) named.push('default: __default')

  const stray = body.match(/^[ \t]*(?:import|export)\s.*$/m)
  if (stray !== null) {
    throw new Error(`dsh-translator build: unsupported ESM syntax in ${name}: ${stray[0].trim()}`)
  }

  const exportsLine = named.length === 0 ? '' : `\nObject.assign(exports, { ${named.join(', ')} });\n`
  return { code: `${requires.join('\n')}\n${body}\n${exportsLine}` }
}

/** Strip a source extension so a specifier matches the module-table key. */
function normalizeSpecifier(spec) {
  return spec.replace(/\.jsx?$/, '')
}

/** Resolve one relative import to an existing file. */
async function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js'), path.join(base, 'index.jsx')]
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8')
      return candidate
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`dsh-translator build: cannot resolve "${spec}" from ${path.relative(ROOT, fromFile)}`)
}

/**
 * The module-table key of a module: relative to the bundle's entry directory,
 * POSIX-style, with the extension stripped so it matches the normalized specifier
 * emitted by {@link transpileImports}.
 *
 * The entry itself is `./index`; every other module is reached by a plain
 * relative specifier (`./styles`, `../shared/select`) — both resolve against the
 * ENTRY directory, because the browser shim's `from` is always the entry id.
 */
function moduleId(file, entryDir) {
  const relative = path.relative(entryDir, file).split(path.sep).join('/').replace(/\.jsx?$/, '')
  return relative.startsWith('..') ? relative : `./${relative}`
}

/** Load one module and, recursively, its local dependencies. */
async function loadModule(file, cache, entryDir) {
  if (cache.has(file)) return
  const { code } = await readModule(file)
  // The emitted specifier is extension-less (it is a module-table key); the graph
  // walk must resolve against the ORIGINAL specifier, which carries the extension.
  const original = await readFile(file, 'utf8')
  const deps = new Set()
  const pattern = /from\s+(['"])([^'"]+)\1|require\(\s*(['"])([^'"]+)\3\s*\)/g
  let match
  while ((match = pattern.exec(original)) !== null) {
    const spec = match[2] ?? match[4]
    if (spec === undefined || !spec.startsWith('.')) continue
    deps.add(await resolveLocal(file, spec))
  }
  cache.set(file, { id: moduleId(file, entryDir), code })
  for (const dep of deps) await loadModule(dep, cache, entryDir)
}

/** The browser bundle's runtime require/resolve shim over one module table. */
function browserShim(cache, entrySpec) {
  const modules = [...cache.values()]
    .map((mod) => `${JSON.stringify(mod.id)}: function (module, exports, require) {\n${mod.code}\n}`)
    .join(',\n')
  return `
var __tables = { ${modules} };
var __cache = {};
function __require(spec) {
  var id = spec.charAt(0) === '.' ? spec : './' + spec;
  if (__tables[id] === undefined) return require(spec);
  if (__cache[id] !== undefined) return __cache[id].exports;
  var mod = { exports: {} };
  __cache[id] = mod;
  __tables[id](mod, mod.exports, __require);
  return mod.exports;
}
module.exports = __require(${JSON.stringify(entrySpec)});
return module.exports;
`
}

/** Build the browser bundle into `lib/client.js`. */
async function buildClient() {
  const entryDir = path.dirname(ENTRY)
  const cache = new Map()
  await loadModule(ENTRY, cache, entryDir)
  const shim = browserShim(cache, moduleId(ENTRY, entryDir))
  const body = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;\n${shim} } });\n`
  await mkdir(path.dirname(OUT), { recursive: true })
  await writeFile(OUT, body, 'utf8')
  console.log(`[dsh-translator] built lib/client.js (${cache.size} modules, ${(Buffer.byteLength(body, 'utf8') / 1024).toFixed(1)} KiB)`)
}

/**
 * Build the host bundle into `lib/index.js`.
 *
 * Node-hosted plugins are ES modules, but this package's own source is written in
 * one style for both halves; the host bundle therefore emits real ESM with the
 * same internal table, and the DSH loader imports it by path.
 *
 * Only the OUTER surface is ESM. The inner table is CommonJS like the browser
 * shim, and its `require` is synchronous: `transpileImports` emits destructuring
 * assignments (`const { LruCache } = require("…")`), which would bind `undefined`
 * against a promise — silently, until the value is finally used.
 */
async function buildHost() {
  const entry = path.join(ROOT, 'src/host/index.js')
  const entryDir = path.dirname(entry)
  const cache = new Map()
  await loadModule(entry, cache, entryDir)

  // The inner table below resolves synchronously, so a host module can never
  // reach an external package. Fail the build rather than emit a bundle whose
  // `require` hands a promise to a destructuring assignment.
  for (const mod of cache.values()) {
    const external = mod.code.match(/require\("([^".][^"]*)"\)/)
    if (external !== null) {
      throw new Error(
        `dsh-translator build: host module ${mod.id} imports the external "${external[1]}", ` +
          'but the host inner table resolves only relative modules',
      )
    }
  }

  const modules = [...cache.values()]
    .map((mod) => `${JSON.stringify(mod.id)}: (module, exports, require) => {\n${mod.code}\n}`)
    .join(',\n')

  const body = `/**
 * Generated by build.mjs — do not edit. Source: src/host/index.js
 * @module dsh-translator
 */
const __tables = { ${modules} };
const __cache = new Map();
function __idOf(spec) {
  return spec.charAt(0) === '.' ? spec.replace(/\\.jsx?$/, '') : spec;
}
function __require(spec) {
  const id = __idOf(spec);
  if (__tables[id] === undefined) {
    throw new Error('dsh-translator bundle: unresolvable module ' + spec);
  }
  if (__cache.has(id)) return __cache.get(id).exports;
  const mod = { exports: {} };
  __cache.set(id, mod);
  __tables[id](mod, mod.exports, __require);
  return mod.exports;
}
const __exports = __require(${JSON.stringify(moduleId(entry, entryDir))});
export const apply = __exports.apply;
export const inject = __exports.inject;
export const name = __exports.name;
export const resolveConfig = __exports.resolveConfig;
export const resolveRoute = __exports.resolveRoute;
export const translateStream = __exports.translateStream;
`
  await writeFile(path.join(ROOT, 'lib/index.js'), body, 'utf8')
  console.log(`[dsh-translator] built lib/index.js (${cache.size} modules, ${(Buffer.byteLength(body, 'utf8') / 1024).toFixed(1)} KiB)`)
}

/** Mirror the transformed sources into `.build-run/` for the Node smoke test. */
async function stage() {
  await rm(STAGE, { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })
  await cp(path.join(ROOT, 'src'), path.join(STAGE, 'src'), { recursive: true })
  for (const file of await collect(path.join(STAGE, 'src'), /\.jsx$/)) {
    const raw = await readFile(file, 'utf8')
    const jsx = transformJsx(raw, path.relative(ROOT, file))
    await writeFile(
      file.replace(/\.jsx$/, '.js'),
      jsx.replace(/(["'][^"']+)\.jsx(["'])/g, '$1.js$2'),
      'utf8',
    )
    await rm(file, { force: true })
  }
  console.log('[dsh-translator] staged .build-run/ for the node smoke test')
}

/** Recursively list files under `dir` matching `pattern`. */
async function collect(dir, pattern) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(full, pattern)))
    else if (pattern.test(entry.name)) out.push(full)
  }
  return out
}

await buildClient()
await buildHost()
if (process.argv.includes('--stage')) await stage()
