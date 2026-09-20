/**
 * Minimal JSX → `React.createElement` transformer for dsh-translator's build.
 *
 * One recursive descent over the source that emits the output as it parses.
 * Everything is local to one call frame — the position, the text being built —
 * so no index is ever handed between two functions.
 *
 * Supported subset (everything this codebase uses): intrinsic and component
 * elements, dotted component names, self-closing tags, string / `{expression}` /
 * `{...spread}` attributes, text and `{expression}` children, and JSX nested in
 * either (conditionals, ternaries, `.map()` callbacks, JSX inside attribute
 * values). Anything else throws with `file:line`.
 *
 * @module dsh-translator/build-jsx
 */

/**
 * Rewrite every JSX element in a JavaScript source file.
 * @param source - the file's text.
 * @param fileName - used in diagnostics.
 * @returns the transformed source.
 * @throws {Error} for JSX constructs outside the supported subset.
 */
export function transformJsx(source, fileName = 'source') {
  let i = 0
  const lineAt = (index) => `${fileName}:${source.slice(0, index).split('\n').length}`

  /** Skip a string or template literal; returns the index after it. */
  const skipLiteral = (index) => {
    const quote = source[index]
    let cursor = index + 1
    while (cursor < source.length) {
      const ch = source[cursor]
      if (ch === '\\') {
        cursor += 2
        continue
      }
      if (ch === quote) return cursor + 1
      cursor += 1
    }
    return cursor
  }

  /** Skip a comment; returns the index after it. */
  const skipComment = (index) => {
    if (source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      return end === -1 ? source.length : end + 1
    }
    const end = source.indexOf('*/', index + 2)
    return end === -1 ? source.length : end + 2
  }

  /** Whether the current position can start a JSX element. */
  const atElement = () => source[i] === '<' && source[i + 1] !== '/' && /[A-Za-z]/.test(source[i + 1] ?? '')

  /**
   * Parse one JSX element; returns its `React.createElement(…)` text.
   * On return the position is exactly after the element's closing `>`.
   */
  const parseElement = () => {
    const line = lineAt(i)
    i += 1 // '<'
    const nameStart = i
    while (i < source.length && /[\w.:$-]/.test(source[i])) i += 1
    const name = source.slice(nameStart, i)
    if (name === '') throw new Error(`dsh-translator build: empty JSX element name (${line})`)

    const props = []
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i += 1
      const ch = source[i]
      if (ch === '>' || ch === '/' || ch === undefined) break
      if (source.slice(i, i + 4) === '{...') {
        i += 4
        const expression = scanExpression('}').trim()
        for (const part of expression.split(',')) props.push(part.trim())
        continue
      }
      const attributeStart = i
      while (i < source.length && /[\w:$-]/.test(source[i])) i += 1
      const attributeName = source.slice(attributeStart, i)
      if (attributeName === '') {
        throw new Error(`dsh-translator build: bad JSX attribute near ${JSON.stringify(source.slice(i, i + 20))} (${line})`)
      }
      const afterName = i
      while (i < source.length && /\s/.test(source[i])) i += 1
      if (source[i] !== '=') {
        props.push(`${JSON.stringify(attributeName)}: true`)
        i = afterName
        continue
      }
      i += 1
      while (i < source.length && /\s/.test(source[i])) i += 1
      if (source[i] === '"' || source[i] === "'") {
        const literal = source.slice(i, skipLiteral(i))
        props.push(`${JSON.stringify(attributeName)}: ${literal}`)
        i += literal.length
        continue
      }
      if (source[i] === '{') {
        i += 1
        const expression = scanExpression('}')
        if (expression.trim() === '') throw new Error(`dsh-translator build: empty JSX attribute expression (${line})`)
        props.push(`${JSON.stringify(attributeName)}: ${expression.trim()}`)
        continue
      }
      throw new Error(`dsh-translator build: JSX attribute "${attributeName}" must be a literal or an expression (${line})`)
    }

    /**
     * Scan JavaScript until the closer of the innermost construct opened by the
     * caller is consumed, transforming JSX on the way. Nesting is tracked with a
     * stack of expected closers, so a mismatched closer is reported, not skipped.
     */
    function scanExpression(closer) {
      const stack = [closer]
      let out = ''
      for (;;) {
        if (i >= source.length) throw new Error(`dsh-translator build: unterminated "${stack[stack.length - 1]}" (${lineAt(i)})`)
        const ch = source[i]
        if (ch === '"' || ch === "'" || ch === '`') {
          const literal = source.slice(i, skipLiteral(i))
          out += literal
          i += literal.length
          continue
        }
        if (atElement()) {
          out += parseElement()
          continue
        }
        if (ch === '{' || ch === '(' || ch === '[') {
          stack.push(ch === '{' ? '}' : ch === '(' ? ')' : ']')
          out += ch
          i += 1
          continue
        }
        if (ch === '}' || ch === ')' || ch === ']') {
          if (ch !== stack[stack.length - 1]) {
            throw new Error(`dsh-translator build: expected "${stack[stack.length - 1]}" but found "${ch}" (${lineAt(i)})`)
          }
          stack.pop()
          i += 1
          if (stack.length === 0) return out
          out += ch
          continue
        }
        out += ch
        i += 1
      }
    }

    let selfClosing = false
    if (source[i] === '/') {
      if (source[i + 1] !== '>') throw new Error(`dsh-translator build: malformed self-closing <${name}/> (${line})`)
      selfClosing = true
      i += 2
    } else {
      if (source[i] !== '>') throw new Error(`dsh-translator build: expected ">" after <${name} …> (${line})`)
      i += 1
    }

    const children = []
    if (!selfClosing) {
      for (;;) {
        if (i >= source.length) throw new Error(`dsh-translator build: unterminated <${name}> (${line})`)
        const ch = source[i]
        if (ch === '<' && source[i + 1] === '/') {
          const closeIndex = source.indexOf('>', i)
          if (closeIndex === -1) throw new Error(`dsh-translator build: unterminated close tag (${line})`)
          const closed = source.slice(i + 2, closeIndex).trim()
          if (closed !== name) {
            throw new Error(`dsh-translator build: expected </${name}> but found </${closed}> (${line})`)
          }
          i = closeIndex + 1
          break
        }
        if (atElement()) {
          children.push(parseElement())
          continue
        }
        if (ch === '<') throw new Error(`dsh-translator build: unexpected "<" in JSX children (${line})`)
        if (ch === '{') {
          i += 1
          const expression = scanExpression('}')
          if (expression.trim() === '') throw new Error(`dsh-translator build: empty JSX expression (${line})`)
          if (expression.trim().startsWith('/*')) {
            throw new Error(`dsh-translator build: JSX comment children are unsupported (${line})`)
          }
          children.push(expression.trim())
          continue
        }
        const textStart = i
        while (i < source.length && source[i] !== '<' && source[i] !== '{') i += 1
        const text = source.slice(textStart, i).replace(/\s+/g, ' ')
        if (text.trim() !== '') children.push(JSON.stringify(text))
      }
    }

    const tag = /^[a-z]/.test(name) ? JSON.stringify(name) : name
    const propsText = props.length === 0 ? 'null' : `{ ${props.join(', ')} }`
    return `React.createElement(${[tag, propsText, ...children].join(', ')})`
  }

  let out = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const literal = source.slice(i, skipLiteral(i))
      out += literal
      i += literal.length
      continue
    }
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const comment = source.slice(i, skipComment(i))
      out += comment
      i += comment.length
      continue
    }
    if (ch === '<' && source[i + 1] === '/') {
      throw new Error(`dsh-translator build: stray close tag (${lineAt(i)})`)
    }
    if (ch === '<' && source[i + 1] === '>') {
      throw new Error(`dsh-translator build: JSX fragments (<>…</>) are unsupported; use <React.Fragment> (${lineAt(i)})`)
    }
    if (atElement()) {
      out += parseElement()
      continue
    }
    out += ch
    i += 1
  }
  return out
}
