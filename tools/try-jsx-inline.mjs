/**
 * Diagnostic: run the JSX transformer on one inline snippet.
 * @module dsh-translator/tools/try-jsx-inline
 */

import { transformJsx } from '../build-jsx.mjs'

const snippet = process.argv[2] ?? 'const a = <div><b>x</b></div>'
try {
  console.log(transformJsx(snippet, 'inline'))
} catch (error) {
  console.log('THREW:', error.message)
}
