/**
 * Diagnostic: show the source window around a JSX transformer failure.
 * @module dsh-translator/tools/try-jsx
 */

import { readFile } from 'node:fs/promises'

import { transformJsx } from '../build-jsx.mjs'

const file = process.argv[2] ?? 'src/client/TranslatePane.jsx'
const raw = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
try {
  const out = transformJsx(raw, file)
  const leftover = out.match(/<[A-Za-z][\w.]*[\s>/]/g) ?? []
  console.log(`ok: in=${raw.length} out=${out.length} leftover-jsx=${leftover.length}`)
} catch (error) {
  console.log('THREW:', error.message)
  const line = Number.parseInt(String(error.message).match(/:(\d+)\)$/)?.[1] ?? '0', 10)
  if (line > 0) {
    const lines = raw.split('\n')
    for (let n = Math.max(0, line - 4); n < Math.min(lines.length, line + 2); n += 1) {
      console.log(`${String(n + 1).padStart(4)} ${n + 1 === line ? '>>' : '  '} ${lines[n]}`)
    }
  }
}
