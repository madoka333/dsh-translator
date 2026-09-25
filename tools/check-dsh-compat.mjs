/**
 * Pre-upgrade tripwire for dsh-translator.
 *
 * DSH's WEB boot walks every client loader entry and THROWS if any of them is not
 * `active` — and `pending (waiting for service: X)` counts as not active. So a dsh
 * upgrade that renames or deletes one service does not break one plugin: it takes
 * the whole Web GUI down to the boot screen. That is exactly what 0.1.7-rc.2 did
 * when it deleted the client-side `settingsScope` service.
 *
 * This tool answers the question the boot screen answers too late: "do the names
 * this plugin binds to still exist in the dsh that is installed right now?"
 *
 * HOW IT CHECKS — and what that is worth
 * --------------------------------------
 * Every service and slot this plugin binds to is read from the BUILT bundles (so
 * it cannot drift from the code), then looked up as a quoted string anywhere in
 * the installed `@deepseek-ai/*` JavaScript and type declarations.
 *
 * A hit means the name is still mentioned in the installed dsh; a MISS is the
 * actionable signal, because a name that no longer appears anywhere cannot be
 * provided or declared. It is a tripwire, not a proof: a name surviving in a
 * comment would pass. It is deliberately cheap, offline and dependency-free so it
 * can run as the first step of every upgrade.
 *
 * usage:
 *   node tools/check-dsh-compat.mjs [--root <node_modules dir>]... [--json]
 *
 * @module dsh-translator/tools/check-dsh-compat
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where an installed dsh keeps its packages, most specific first. */
export function defaultRoots() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return [
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai'),
    join(homedir(), 'node_modules', '@deepseek-ai'),
  ]
}

/**
 * Cached bindings: the bundle can only be evaluated once per process (the module
 * cache makes a second import a no-op), so the result is remembered.
 */
let bindingsCache

/** Read the names this plugin binds to, from the BUILT bundles. */
export async function declaredBindings() {
  if (bindingsCache !== undefined) return bindingsCache
  // The client bundle is an IIFE that hands a factory to dsh's module loader; the
  // exports only exist once that factory has been called, exactly as in the page.
  let registration
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  globalThis.document = {
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, remove() {} }),
    body: { appendChild() {} },
    head: { appendChild() {} },
    getElementById: () => null,
    addEventListener() {},
  }
  await import(new URL('../lib/client.js', import.meta.url).href)
  if (registration === undefined) throw new Error('lib/client.js did not register a module factory — run `node build.mjs` first')
  const client = registration.factory((specifier) => {
    if (specifier === 'react') return { createElement: () => null, Fragment: {} }
    if (specifier === 'react-dom') return { createPortal: () => null }
    if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    throw new Error(`unexpected external require: ${specifier}`)
  })
  const host = await import(new URL('../lib/index.js', import.meta.url).href)
  bindingsCache = {
    services: [
      ...client.SIDEBAR_SERVICES,
      ...client.SETTINGS_SERVICES,
      client.SESSION_SCOPE_SERVICE,
      ...host.inject,
    ].filter((name, index, all) => all.indexOf(name) === index),
    slots: [...client.SLOT_SEATS],
  }
  return bindingsCache
}

/** Every candidate file under one `@deepseek-ai` root. */
export async function collectFilesForTest(root) {
  return collectFiles(root)
}

/** Every candidate file under one `@deepseek-ai` root. */
async function collectFiles(root) {
  const files = []
  let packages
  try {
    packages = await readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const pkg of packages) {
    if (!pkg.isDirectory() && !pkg.isSymbolicLink()) continue
    const lib = join(root, pkg.name, 'lib')
    if (!existsSync(lib)) continue
    const stack = [lib]
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) stack.push(path)
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) files.push(path)
      }
    }
  }
  return files
}

/**
 * Whether one quoted name appears in the installed dsh packages.
 * @param name - the exact service or slot name.
 * @param files - candidate files from {@link collectFiles}.
 * @returns the first file that mentions it, or undefined.
 */
export async function findName(name, files) {
  const needle = `"${name}"`
  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes(needle)) return file
  }
  return undefined
}

/** Run the check. @returns `{roots, files, rows, missing}`. */
export async function runCheck(roots = defaultRoots()) {
  const bindings = await declaredBindings()
  const existing = []
  const files = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const info = await stat(root).catch(() => undefined)
    if (info === undefined) continue
    existing.push(root)
    files.push(...(await collectFiles(root)))
  }
  const rows = []
  for (const name of bindings.services) rows.push({ kind: 'service', name, found: await findName(name, files) })
  for (const name of bindings.slots) rows.push({ kind: 'slot', name, found: await findName(name, files) })
  return { roots: existing, scans: files.length, rows, missing: rows.filter((row) => row.found === undefined) }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())

if (isMain) {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const roots = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--root') roots.push(argv[i + 1])
  const result = await runCheck(roots.length > 0 ? roots : defaultRoots())
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`scanned ${result.scans} files under ${result.roots.length} root(s):`)
    for (const root of result.roots) console.log(`  - ${root}`)
    for (const row of result.rows) {
      console.log(`${row.found === undefined ? 'MISSING' : 'ok     '} ${row.kind.padEnd(7)} ${row.name}`)
      if (row.found !== undefined && !asJson) console.log(`        ${row.found}`)
    }
    if (result.missing.length === 0) {
      console.log('\ncompat check passed: every service and slot this plugin binds to still exists in the installed dsh.')
    } else {
      console.log(
        `\ncompat check FAILED: ${result.missing.length} binding(s) no longer exist in the installed dsh.\n` +
          'Each one would park a capability — and a parked CLIENT entry makes dsh web boot throw.\n' +
          'Fix: re-point the binding in src/client/index.jsx (services are read through `ctx.get`,\n' +
          'capabilities wait in their own `ctx.inject([...])` child fiber).',
      )
    }
  }
  process.exit(result.missing.length === 0 ? 0 : 1)
}
