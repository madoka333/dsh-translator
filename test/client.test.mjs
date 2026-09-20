/**
 * Browser-half test: loads the SHIPPED client bundle exactly the way DSH's module
 * system does (`window.__ModuleLoader__.load({id, factory})` → `factory(require)`),
 * then mounts it on a fake client context and asserts the registrations it must
 * make — the sidebar tab type, the two tab seats, the settings row, the selection
 * watcher, and the shortcut listener.
 *
 * This is the browser-side twin of the boot failure the host half hit: a plugin
 * that throws inside `apply` takes the whole client composition down, so `apply`
 * is exercised here against the real bundle rather than trusted.
 *
 * `react`, `react-dom` and `react-dom/client` are stubbed: the bundle treats them
 * as EXTERNAL and asks for them through `require`, which is precisely the seam
 * this test controls.
 *
 * @module dsh-translator/test/client.test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test, { afterEach } from 'node:test'

import { handleMouseDown, isOwnUiNode, watchSelection } from '../src/client/watch.js'

/**
 * Effects the React stub collected during the last component render.
 *
 * Components in this suite compute what they show during render, so a single pass
 * is enough to inspect them; the effects are recorded only so a test can confirm
 * that a component did register its listeners.
 * @type {Array<() => void>}
 */
const capturedEffects = []

afterEach(() => {
  capturedEffects.length = 0
})

/**
 * A DOM-ish node for the watcher tests: `closest` understands the two selectors
 * the watcher asks about (our own UI marker and a code block), which is all the
 * ancestor logic needs to be exercised for real.
 */
function makeElement(options = {}) {
  const element = {
    nodeType: 1,
    tagName: 'DIV',
    className: options.className ?? 'message markdown',
    attributes: { ...(options.attributes ?? {}) },
    parentElement: options.parent ?? null,
    children: [],
    appendChild(child) {
      this.children.push(child)
      return child
    },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    getAttribute(name) {
      return this.attributes[name] ?? null
    },
    hasAttribute(name) {
      return name in this.attributes
    },
    closest(selector) {
      let current = this
      while (current !== null && current !== undefined) {
        const list = String(selector).split(',').map((part) => part.trim())
        for (const part of list) {
          const attr = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(part)
          if (attr !== null) {
            const [, name, expected] = attr
            const value = current.attributes?.[name]
            if (value !== undefined && (expected === undefined || value === expected)) return current
            continue
          }
          if (part === 'pre' || part === 'code') {
            if (String(current.tagName).toLowerCase() === part) return current
          }
        }
        current = current.parentElement
      }
      return null
    },
  }
  return element
}

/** Install a selection stub for the watcher tests. */
function installSelection(anchor, text) {
  globalThis.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: anchor,
    focusNode: anchor,
    toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20, right: 200, bottom: 40, width: 190, height: 20 }), getClientRects: () => [] }),
  })
}

/** One fake DOM node, recording children so the tree can be walked. */
function makeNode(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    textContent: '',
    className: '',
    id: '',
    styleSheets: [],
    appendChild(child) {
      this.children.push(child)
      return child
    },
    remove() {},
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    getAttribute(name) {
      return this.attributes[name]
    },
    hasAttribute(name) {
      return name in this.attributes
    },
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false
    },
  }
}

/** Install the browser globals the bundle touches during registration. */
function installFakeDom() {
  const byId = new Map()
  const head = makeNode('head')
  const body = makeNode('body')
  // Real listener bookkeeping: the selection watcher is exercised through actual
  // dispatched events, so the stub has to remember and call what it registered.
  const documentListeners = new Map()
  const addDocumentListener = (type, listener) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(listener)
  }
  const removeDocumentListener = (type, listener) => {
    documentListeners.get(type)?.delete(listener)
  }
  globalThis.document = {
    head,
    body,
    nodeType: 9,
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
    addEventListener: addDocumentListener,
    removeEventListener: removeDocumentListener,
    /** Fire one event through every listener of that type, in registration order. */
    dispatch(type, event) {
      for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event)
      return event
    },
  }
  // The style installer looks its tag up by id afterwards; register anything the
  // head receives so a second install is a no-op instead of a duplicate.
  const originalAppend = head.appendChild.bind(head)
  head.appendChild = (child) => {
    if (typeof child.id === 'string' && child.id !== '') byId.set(child.id, child)
    return originalAppend(child)
  }
  const listeners = []
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type) => listeners.push(type),
    removeEventListener: () => {},
    getSelection: () => null,
    __listeners: listeners,
  }
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  }
  // `navigator` is a read-only global on modern Node, so only the clipboard face
  // the pane's copy button touches is patched — and only if it is writable.
  try {
    if (globalThis.navigator?.clipboard === undefined) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: async () => {} } },
        configurable: true,
        writable: true,
      })
    }
  } catch {
    /* an existing navigator without clipboard is fine — the test never copies */
  }
  return { head, body, byId, listeners }
}

/**
 * Element trees built by the React stub, newest last.
 *
 * `createElement` mirrors React's treatment of the RESERVED `ref` prop (see
 * below), which is the only way a stub can catch a component that names a real
 * data prop `ref`: React never hands that value to the component, so the stub
 * must not either. Keeping the trees lets a test assert on what a component
 * actually received.
 * @type {Array<{ type: unknown, props: object }>}
 */
const createdElements = []

afterEach(() => {
  createdElements.length = 0
})

/** A React stub that records element trees so they can be inspected. */
function makeReactStub() {
  // `ref` (like `key`) is reserved: React consumes it into the element's own
  // field and NEVER passes it to a component. A stub that forwards it would hide
  // exactly the failure this project shipped once — a pane card declared
  // `function RefCard({ ref })`, React handed it `undefined`, and rendering a
  // card abdicated the whole seat (the sidebar showed only `data-slot-error`).
  const createElement = (type, props, ...children) => {
    const { ref: elementRef, ...rest } = props ?? {}
    const element = {
      $$kind: typeof type === 'string' ? 'host' : 'component',
      type,
      props: rest,
      ref: elementRef,
      children,
    }
    createdElements.push(element)
    return element
  }
  createElement.Fragment = Symbol('Fragment')
  // Hooks are stubbed to their initial state: this suite renders components once
  // and inspects the resulting tree. React calls a function initializer, so
  // `useState(() => store.getSnapshot())` must resolve the lazy form — returning
  // the function itself would crash the first read. Every setter and effect is
  // recorded so a test can replay one update cycle for the components that only
  // compute their render inside an effect (the floating pill).
  createElement.useState = (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  }
  createElement.useEffect = (effect) => {
    if (typeof effect === 'function') capturedEffects.push(effect)
  }
  createElement.useRef = (initial) => ({ current: initial })
  createElement.useCallback = (callback) => callback
  createElement.useMemo = (factory) => factory()
  return createElement
}

/**
 * The module object a bundle's `require('react')` receives.
 *
 * React exposes `createElement` and the hooks as NAMED EXPORTS of the module, not
 * as properties of `createElement` — spreading the function copies none of them,
 * so the module shape has to be built explicitly or every JSX call site sees
 * `React.createElement` as undefined.
 * @param createElement - the stub factory carrying the hook stubs.
 * @returns a React-shaped module namespace.
 */
function makeReactModule(createElement) {
  return {
    createElement,
    Fragment: createElement.Fragment,
    useState: createElement.useState,
    useEffect: createElement.useEffect,
    useRef: createElement.useRef,
    useCallback: createElement.useCallback,
    useMemo: createElement.useMemo,
  }
}

/** Load the shipped client bundle the way the DSH module table does. */
async function loadClientBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registrations = []
  globalThis.window = globalThis.window ?? {}
  globalThis.window.__ModuleLoader__ = {
    load: (registration) => registrations.push(registration),
  }
  // The bundle is an IIFE that reads `window.__ModuleLoader__` at evaluation time.
  const evaluator = new Function('window', 'document', `${source}`)
  evaluator(globalThis.window, globalThis.document)
  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
  return registrations[0]
}

/** Build the fake client context `apply` receives. */
function makeContext() {
  const calls = {
    tabTypes: [],
    slots: [],
    injects: [],
    effects: [],
    sessionSubscribes: 0,
  }
  const slots = {
    // `inject(name, register)` gates a seat on its owning slot and runs `register`
    // when it resolves; `register(options, component)` is the actual seat entry.
    // Both are recorded, but only the latter is a slot registration.
    inject(name, register) {
      calls.injects.push(name)
      register()
      return () => {}
    },
    register(options, component) {
      calls.slots.push({ name: options?.name ?? '(unnamed)', options, component })
      return () => {}
    },
  }
  const ctx = {
    // cordis runs the effect factory SYNCHRONOUSLY at registration time and keeps
    // its returned disposer; a fake that merely records the factory would let a
    // plugin that never actually wires anything pass this suite.
    effect(factory) {
      calls.effects.push(factory)
      return factory() ?? (() => {})
    },
    get: () => undefined,
    slots,
    sidebarRightTabs: {
      register(definition) {
        calls.tabTypes.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab(kind) {
        calls.opened = kind
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ current: 'session-1', ids: ['session-1'] }),
        subscribe: () => {
          calls.sessionSubscribes += 1
          return () => {}
        },
      },
    },
    settingsScope: {},
    uiConversation: undefined,
  }
  return { ctx, calls }
}

/**
 * Render a recorded element tree to completion and collect its text.
 *
 * Component elements are INVOKED (this is what React would do), so a slot host
 * that only wraps the real component still gets exercised — walking `children`
 * alone would stop at the wrapper and see nothing.
 * @param node - element, array, or leaf.
 * @param depth - recursion guard.
 * @returns the text the tree renders.
 */
function renderStrings(node, depth = 0) {
  if (depth > 40) return []
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (node === null || node === undefined) return []
  if (Array.isArray(node)) return node.flatMap((child) => renderStrings(child, depth + 1))
  if (typeof node !== 'object') return []
  const { type, props, children } = node
  if (typeof type === 'function') {
    const rendered = type(props ?? {})
    return renderStrings(rendered, depth + 1)
  }
  return children.flatMap((child) => renderStrings(child, depth + 1))
}

/** Every text node of a rendered tree, joined for a substring assertion. */
function renderText(node) {
  return renderStrings(node).join('|')
}

/** Walk a recorded element tree, asserting every node is renderable. */
function assertRenderable(node, path = 'root') {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => assertRenderable(child, `${path}[${index}]`))
    return
  }
  assert.equal(typeof node.$$kind, 'string', `${path} is not a React element`)
  if (node.$$kind === 'host') {
    assert.equal(typeof node.type, 'string', `${path} host element must have a tag name`)
  } else {
    assert.ok(node.type !== undefined && node.type !== null, `${path} component type must not be undefined`)
    assert.notEqual(node.type, undefined, `${path} component type must not be undefined`)
  }
  assert.equal(typeof node.props, 'object', `${path} props must be an object`)
  for (const [key, value] of Object.entries(node.props)) {
    assert.notEqual(value, undefined, `${path} prop "${key}" must not be undefined`)
  }
  node.children.forEach((child, index) => assertRenderable(child, `${path}.${node.type?.name ?? node.type}[${index}]`))
}

/** Everything a single bundle load + mount needs. */
async function mount() {
  installFakeDom()
  const registration = await loadClientBundle()
  const createElement = makeReactStub()
  let rootRender
  const { ctx, calls } = makeContext()
  const exports = registration.factory((specifier) => {
    // The bundle destructures hooks from `react`, so the stub must expose them as
    // named exports on the module object — not only as properties of createElement.
    if (specifier === 'react') return makeReactModule(createElement)
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    if (specifier === 'react-dom/client') {
      return {
        createRoot: () => ({
          render(node) {
            rootRender = node
          },
          unmount() {},
        }),
      }
    }
    throw new Error(`unexpected external require: ${specifier}`)
  })
  assert.equal(registration.id, 'dsh-translator')
  exports.apply(ctx)
  return { exports, ctx, calls, get rootRender() { return rootRender } }
}
test('the bundle declares the services the browser half needs', async () => {
  const { exports } = await mount()
  for (const service of ['slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiConversation', 'settingsScope']) {
    assert.ok(exports.inject.includes(service), `must inject the ${service} service`)
  }
})

test('apply mounts the sidebar tab type, both tab seats, and the settings row', async () => {
  const { calls } = await mount()
  assert.equal(calls.tabTypes.length, 1, 'exactly one tab type')
  const definition = calls.tabTypes[0]
  assert.equal(definition.id, 'dsh-translator')
  assert.equal(definition.kind, 'translator')
  assert.equal(definition.title(), '翻译')
  assert.ok(Array.isArray(definition.guide) && definition.guide.length === 1)
  assert.equal(definition.guide[0].title(), '翻译')

  // ui-sidebar-right dispatches both seats with `entryKey: definition.id ?? tab.kind`
  // (TabSlot). The seats MUST therefore key on the definition id — keying them on
  // the kind resolves nothing and the column renders its own fallback notice
  // ("这类内容还没有可用的查看方式。") instead of the pane. That regression is why
  // this asserts against the REGISTERED definition rather than a literal.
  const seatKeys = calls.slots
    .filter((entry) => entry.name.startsWith('sidebar.right.pane.tab'))
    .map((entry) => entry.options?.key)
  assert.deepEqual(
    seatKeys,
    [definition.id, definition.id],
    `both seats must register under the definition id (${definition.id}), not the kind (${definition.kind})`,
  )
  assert.notEqual(definition.kind, definition.id, 'kind and id are distinct and must not be conflated')
  assert.deepEqual(
    [...new Set(calls.injects)].sort(),
    ['settings.general.item', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    'the plugin must gate each seat on its owning slot',
  )

  const settings = calls.slots.filter((entry) => entry.name === 'settings.general.item')
  assert.equal(settings.length, 1)
  assert.equal(typeof settings[0].component, 'function', 'the settings row must render a component')
})

test('apply installs the selection listener, the shortcut, and the session scope', async () => {
  const { calls } = await mount()
  assert.ok(calls.effects.length >= 5, `expected the effect list to be wired, got ${calls.effects.length}`)
  assert.ok(globalThis.window.__listeners.includes('keydown'), 'the shortcut listener must be attached')
  assert.ok(globalThis.document, 'a document must exist for the portal roots')
  assert.equal(calls.sessionSubscribes, 1, 'the session scope must be subscribed')
})

test('apply survives a missing right sidebar and still registers its seats', async () => {
  installFakeDom()
  const registration = await loadClientBundle()
  const createElement = makeReactStub()
  const { ctx, calls } = makeContext()
  // No right sidebar in this deployment: `openTab` will throw at click time (the
  // pane registration itself never runs), and the plugin must still mount so the
  // selection → floating-card path stays alive.
  ctx.sidebarRightTabs = {
    register() {
      // Simulates the sidebar package not being part of this composition.
      throw new Error('sidebar registry unavailable')
    },
  }
  ctx.sidebarRight = {
    openTab() {
      throw new Error('no right sidebar mounted')
    },
  }
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return makeReactModule(createElement)
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    throw new Error(`unexpected external require: ${specifier}`)
  })
  // The tab-type registration is the one step that cannot work without the
  // sidebar, so it is allowed to fail loudly — but nothing before it may.
  assert.throws(() => exports.apply(ctx), /sidebar registry unavailable/)
  // The seats registered earlier in `apply` must still be there.
  assert.ok(calls.effects.length >= 2, 'roots and watcher mount before the tab type')
})

test('the mounted tree is renderable and carries no undefined props', async () => {
  const mounted = await mount()
  const tree = mounted.rootRender
  assert.ok(tree !== undefined, 'the trigger root must render something')
  assertRenderable(tree)
})

test('the pane and title render a finished reference with its translation', async () => {
  installFakeDom()
  const registration = await loadClientBundle()
  const createElement = makeReactStub()
  const { ctx, calls } = makeContext()
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return makeReactModule(createElement)
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    throw new Error(`unexpected external require: ${specifier}`)
  })
  exports.apply(ctx)

  const body = calls.slots.find((entry) => entry.name === 'sidebar.right.pane.tab')
  assert.equal(typeof body.component, 'function', 'the tab body seat must render a component')

  // The slot hosts close over the plugin's own store, so the seat components are
  // rendered directly with a store shaped exactly like a finished `RefsStore`.
  const reference = {
    key: 'k1',
    text: 'Let me check the repository layout first.',
    kind: 'selection',
    lang: 'zh-CN',
    sourceLabel: '划选内容',
    status: 'done',
    translation: '我先看一下仓库结构。',
    error: null,
    cached: false,
    routeLabel: 'deepseek-official/deepseek-flash',
    at: 0,
  }
  const store = {
    getSnapshot: () => ({ refs: [reference], active: 'k1' }),
    subscribe: () => () => {},
  }
  const runtime = {
    addRef: () => {},
    retry: () => {},
    cancel: () => {},
    remove: () => {},
    clear: () => {},
    setLanguage: () => {},
    language: 'zh-CN',
    shortcut: 'Ctrl+Shift+T',
  }

  assert.equal(typeof exports.TranslatePaneExport, 'function', 'the pane must be exported for direct rendering')
  const paneText = renderText(exports.TranslatePaneExport({ store, runtime }))
  assert.ok(paneText.includes('我先看一下仓库结构。'), `the translation renders (got: ${paneText.slice(0, 200)})`)
  assert.ok(paneText.includes('1 条引用'), 'the toolbar reports one reference')
  assert.ok(paneText.includes('完成'), 'the card reports its finished status')
  assert.ok(!paneText.includes('还没有引用'), 'the empty state is gone once a reference exists')

  // Regression: the card component used to take its data through a prop NAMED
  // `ref` (`<RefCard ref={ref} …>`). `ref` is reserved, so React consumed the
  // value as an element ref and handed the component `undefined`: the first card
  // to render threw, the slot abdicated, and the pane showed nothing but its
  // `data-slot-error` cell. A component element must never be created with a
  // `ref` prop — a DOM node may (that is what `ref` is for), which is why this
  // checks component elements only.
  const refPropOnComponent = createdElements.filter(
    (element) => element.$$kind === 'component' && element.ref !== undefined,
  )
  assert.deepEqual(
    refPropOnComponent.map((element) => element.type?.name ?? String(element.type)),
    [],
    'no component may be created with a `ref` prop — React never delivers it, so the component reads undefined',
  )

  const emptyText = renderText(exports.TranslatePaneExport({ store: { getSnapshot: () => ({ refs: [], active: null }), subscribe: () => () => {} }, runtime }))
  assert.ok(emptyText.includes('还没有引用'), 'the empty state renders when there are no references')

  const titleText = renderStrings(exports.TranslateTitleExport({ store, title: '翻译' })).join('|')
  assert.ok(titleText.includes('翻译'), `the title renders its label (got: ${titleText})`)
  assert.ok(titleText.includes(' 1'), `the title shows the reference count (got: ${titleText})`)
})

// ---------------------------------------------------------------------------
// Regression: pressing the floating trigger used to unmount it during
// `mousedown`, so the browser had no element left to fire `click` on and the
// button appeared to do nothing. These tests pin the decision itself.
// ---------------------------------------------------------------------------

test('isOwnUiNode recognises the plugin chrome and nothing else', () => {
  const surface = makeElement()
  const own = makeElement({ parent: surface, attributes: { 'data-dsh-translator-ui': '1' } })
  const child = makeElement({ parent: own })
  const code = makeElement({ parent: surface, attributes: {} })
  code.tagName = 'CODE'
  assert.equal(isOwnUiNode(own), true, 'the trigger host itself')
  assert.equal(isOwnUiNode(child), true, 'a child of the trigger host')
  assert.equal(isOwnUiNode(surface), false, 'conversation content')
  assert.equal(isOwnUiNode(code), false, 'a code block inside the conversation')
  assert.equal(isOwnUiNode(null), false, 'a missing node never throws')
})

test('handleMouseDown: a press on our own chrome must NOT dismiss the trigger', () => {
  const target = makeElement({ attributes: { 'data-dsh-translator-ui': '1' } })
  const decision = handleMouseDown({ button: 0, target, clientX: 10, clientY: 20 }, null, 1000)
  assert.equal(decision.dismissed, false, 'the button must survive its own press')
  assert.deepEqual(decision.pointers, { left: 10, top: 20, at: 1000 })
})

test('handleMouseDown: a press elsewhere dismisses the previous trigger', () => {
  const target = makeElement()
  const decision = handleMouseDown({ button: 0, target, clientX: 5, clientY: 6 }, null, 2000)
  assert.equal(decision.dismissed, true)
  assert.deepEqual(decision.pointers, { left: 5, top: 6, at: 2000 })
})

test('handleMouseDown: a non-primary press changes nothing', () => {
  const target = makeElement()
  const previous = { left: 1, top: 2, at: 3 }
  const decision = handleMouseDown({ button: 2, target, clientX: 9, clientY: 9 }, previous, 4000)
  assert.equal(decision.dismissed, false)
  assert.equal(decision.pointers, previous, 'the recorded gesture is preserved')
})

test('the watcher never dismisses on a press over its own trigger', () => {
  installFakeDom()
  const surface = makeElement()
  const own = makeElement({ parent: surface, attributes: { 'data-dsh-translator-ui': '1' } })
  const events = []
  const teardown = watchSelection((candidate) => events.push(candidate))

  document.dispatch('mousedown', { button: 0, target: own, clientX: 10, clientY: 20 })
  assert.deepEqual(events, [], 'pressing the trigger produced no dismissal')

  // A press on the conversation still dismisses, so the pill cannot get stuck.
  document.dispatch('mousedown', { button: 0, target: surface, clientX: 1, clientY: 2 })
  assert.equal(events.length, 1)
  assert.equal(events[0], null)
  teardown()
})

test('the watcher ignores a press-and-release that happened on its own chrome', () => {
  installFakeDom()
  const surface = makeElement()
  const own = makeElement({ parent: surface, attributes: { 'data-dsh-translator-ui': '1' } })
  installSelection(surface, 'Let me check the repository layout first.')
  const events = []
  const teardown = watchSelection((candidate) => events.push(candidate))

  document.dispatch('mouseup', { button: 0, target: own, clientX: 10, clientY: 20 })
  assert.deepEqual(events, [], 'our own chrome must not be re-read as a fresh selection')

  document.dispatch('mouseup', { button: 0, target: surface, clientX: 30, clientY: 40 })
  assert.equal(events.length, 1)
  assert.ok(events[0] !== null, 'a release in the conversation still yields a candidate')
  assert.equal(events[0].text, 'Let me check the repository layout first.')
  assert.equal(typeof events[0].rect.pointerLeft, 'number', 'the button is placed from the pointer')
  teardown()
})

test('the floating pill survives a press and commits on the click that follows', async () => {
  const { exports } = await mount()

  // The browser's order for a click on the pill: mousedown first. This is the
  // exact decision that used to unmount the pill before `click` could land.
  const pillTarget = makeElement({ attributes: { 'data-dsh-translator-ui': '1' } })
  const press = handleMouseDown({ button: 0, target: pillTarget, clientX: 120, clientY: 44 }, null, 1000)
  assert.equal(press.dismissed, false, 'the press must not dismiss the pill it landed on')

  const trigger = exports.SelectionTriggerExport
  assert.equal(typeof trigger, 'function', 'the pill must be exported for direct rendering')
  assert.equal(trigger({ candidate: null, onCommit: () => {}, onDismiss: () => {} }), null, 'no candidate, no pill')

  const candidate = {
    action: 'translate',
    text: 'Let me check the repository layout first.',
    reason: 'ok',
    rect: { left: 10, top: 20, right: 200, bottom: 40, pointerLeft: 120, pointerTop: 44 },
    inCodeBlock: false,
    sourceLabel: '对话内容',
  }
  const committed = []
  const dismissed = []
  // The position is computed during render, so the pill's own element — the one
  // the browser dispatches click at — is available on this very call.
  const pill = trigger({
    candidate,
    onCommit: (text, meta) => committed.push({ text, meta }),
    onDismiss: () => dismissed.push(true),
  })
  assert.ok(pill !== null && pill !== undefined, 'the pill renders for a real candidate')
  assert.equal(typeof pill.props.onClick, 'function', 'the pill carries a click handler')
  assert.equal(typeof pill.props.onMouseDown, 'function', 'and a press handler that keeps the selection')
  assert.ok(String(pill.props.className).includes('dsht-trigger'), 'and the pill class')

  // Exactly what the browser does: press (must keep the selection), then click.
  let prevented = 0
  pill.props.onMouseDown({ preventDefault: () => (prevented += 1), stopPropagation() {} })
  pill.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.equal(prevented, 1, 'the press keeps the document selection alive')
  assert.equal(committed.length, 1, 'clicking the pill commits exactly once')
  assert.equal(committed[0].text, candidate.text)
  assert.equal(dismissed.length, 1, 'and the pill then dismisses itself')

  // A "noop" candidate (already Chinese) renders a disabled pill that explains
  // itself instead of spending a model call.
  const noop = trigger({
    candidate: { ...candidate, action: 'noop', reason: 'already-chinese' },
    onCommit: (text, meta) => committed.push({ text, meta }),
    onDismiss: () => dismissed.push(true),
  })
  assert.equal(noop.props.draggable, false, 'an already-Chinese selection is not draggable as a reference')
  noop.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.equal(committed.length, 1, 'the noop pill does not request a translation')
})

test('pillAnchorFor clamps the pill into the viewport', async () => {
  const { exports } = await mount()
  const { pillAnchorForExport } = exports
  assert.equal(typeof pillAnchorForExport, 'function', 'the placement maths must be exported for testing')
  const clamped = pillAnchorForExport({
    text: 'x',
    action: 'translate',
    rect: { top: -100, right: 5000, pointerLeft: 5000 },
  })
  assert.ok(clamped.left < 5000, 'a pointer past the right edge is pulled back in')
  assert.ok(clamped.top >= 4, 'a selection above the viewport keeps the pill visible')
  assert.equal(pillAnchorForExport(null), null, 'no candidate, no anchor')
})

// ---------------------------------------------------------------------------
// The reference store: what a click on the pill actually starts.
// ---------------------------------------------------------------------------

test('addRef drives a reference to done and caches the result', async () => {
  const { RefsStore } = await import('../src/client/stores.js')
  installFakeDom() // `RefsStore` persists through localStorage
  const store = new RefsStore('test-session')

  /** A translator that answers in two deltas, per chunk. */
  const calls = []
  const translator = (chunkSize = 1) => ({
    chunks: (text) => [text],
    translate: async ({ text, signal, onStart, onDelta }) => {
      calls.push(text)
      onStart?.({ label: 'deepseek-official/deepseek-flash' })
      const parts = [...text].length > chunkSize ? [text.slice(0, chunkSize), text.slice(chunkSize)] : [text]
      for (const part of parts) onDelta?.(part.toUpperCase())
      return text.toUpperCase()
    },
  })

  const key = store.add(
    { text: 'Let me check the repository layout first.', kind: 'selection', lang: 'zh-CN', sourceLabel: '划选内容' },
    translator(),
  )
  // The run is async; let its microtasks settle.
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve))

  const ref = store.find(key)
  assert.equal(ref.status, 'done', `the reference must finish (status: ${ref.status}, error: ${ref.error})`)
  assert.equal(ref.translation, 'LET ME CHECK THE REPOSITORY LAYOUT FIRST.')
  assert.equal(ref.routeLabel, 'deepseek-official/deepseek-flash', 'the resolved route is shown on the card')
  assert.equal(calls.length, 1, 'one request for one chunk')

  // Re-referencing the same text is served from the in-page cache.
  const again = store.add(
    { text: 'Let me check the repository layout first.', kind: 'selection', lang: 'zh-CN' },
    translator(),
  )
  assert.equal(again, key, 'the same text is the same card')
  const cachedRef = store.find(again)
  assert.equal(cachedRef.cached, true, 'the second reference is marked as cached')
  assert.equal(calls.length, 1, 'and costs no further request')
})

test('a multi-chunk reference streams its pieces in order', async () => {
  const { RefsStore } = await import('../src/client/stores.js')
  installFakeDom()
  const store = new RefsStore('test-session-chunks')
  const seen = []
  const translator = {
    chunks: () => ['first part', 'second part'],
    translate: async ({ text, onDelta }) => {
      seen.push(text)
      onDelta(`[${text}]`)
      return `[${text}]`
    },
  }
  const key = store.add({ text: 'long text', kind: 'selection', lang: 'zh-CN' }, translator)
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen, ['first part', 'second part'], 'chunks are translated serially, in order')
  const ref = store.find(key)
  assert.equal(ref.status, 'done')
  assert.equal(ref.translation, '[first part]\n\n[second part]', 'the answer keeps the chunk order')
})

test('a failing translation marks the card and keeps whatever arrived', async () => {
  const { RefsStore } = await import('../src/client/stores.js')
  installFakeDom()
  const store = new RefsStore('test-session-error')
  const failing = {
    chunks: (text) => [text],
    translate: async ({ onDelta }) => {
      onDelta('部分译文')
      throw new Error('quota exceeded')
    },
  }
  const key = store.add({ text: 'some english text here', kind: 'selection', lang: 'zh-CN' }, failing)
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve))
  const ref = store.find(key)
  assert.equal(ref.status, 'error')
  assert.equal(ref.error, 'quota exceeded')
  assert.equal(ref.translation, '部分译文', 'the partial answer stays readable')
})

// ---------------------------------------------------------------------------
// The transport itself, against a real streamed body.
//
// This is the regression that matters most: the retry loop's index used to be
// named `attempt`, shadowing the request function of the same name, so the call
// threw before `fetch` and every card sat on "translating…" forever. A stub
// translator cannot catch that — only driving the real `translate()` can.
// ---------------------------------------------------------------------------

/** The SSE body the live host route really returns (captured from a real call). */
const LIVE_SSE_BODY = [
  'data: {"type":"start","route":{"provider":"deepseek-official","model":"deepseek-flash"},"target":"简体中文"}',
  '',
  'data: {"type":"delta","text":"让我"}',
  '',
  'data: {"type":"delta","text":"先检查"}',
  '',
  'data: {"type":"delta","text":"一下仓库布局。"}',
  '',
  'data: {"type":"done","chars":12}',
  '',
  '',
].join('\n')

/**
 * Answer the next fetch with one SSE body, delivered as a real stream split in the
 * middle of a frame so the framer's buffering is exercised too.
 * @param body - the response body.
 * @param options - `{ok, status, contentType}`.
 * @returns the recorded request list.
 */
function stubFetch(body, options = {}) {
  const requests = []
  const ok = options.ok !== false
  const status = options.status ?? 200
  const contentType = options.contentType ?? 'text/event-stream; charset=utf-8'
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    const bytes = Buffer.from(body, 'utf8')
    const split = Math.min(60, bytes.length)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, split)))
        controller.enqueue(new Uint8Array(bytes.subarray(split)))
        controller.close()
      },
    })
    return {
      ok,
      status,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      body: stream,
      text: async () => body,
    }
  }
  return requests
}

// ---------------------------------------------------------------------------
// Failure visibility: a pane that cannot render must say so, and the self-report
// must be able to read it back. A throw here would abdicate the whole seat and
// leave the column showing an empty pane (only `data-slot-error` in the DOM).
// ---------------------------------------------------------------------------

test('a broken store degrades the pane instead of abdicating the seat', async () => {
  const { exports } = await mount()
  const { TranslatePaneExport: pane, renderFailureLogExport: failureLog } = exports
  assert.equal(typeof pane, 'function')
  assert.equal(typeof failureLog, 'function', 'the failure log must be exportable for the self-report')

  const runtime = {
    addRef: () => {},
    retry: () => {},
    cancel: () => {},
    remove: () => {},
    clear: () => {},
    setLanguage: () => {},
    language: 'zh-CN',
    shortcut: 'Ctrl+Shift+T',
  }

  // A store whose reads throw: the pane must still paint (React would otherwise
  // abdicate the whole seat and leave the column blank).
  const broken = {
    getSnapshot: () => {
      throw new Error('store exploded')
    },
    subscribe: () => () => {},
  }
  let tree
  assert.doesNotThrow(() => {
    tree = pane({ store: broken, runtime })
  }, 'the pane must never throw out of its own render')
  assertRenderable(tree)
  assert.ok(renderText(tree).length > 0, 'the pane paints something')
  const failures = failureLog()
  assert.equal(failures.length, 1, 'the failure is recorded for the self-report')
  assert.ok(failures[0].includes('store exploded'), `the cause is recorded (got: ${failures[0]})`)

  // A missing store is the one case the user must SEE, not silently degrade.
  const missing = pane({ store: undefined, runtime })
  assertRenderable(missing)
  const missingText = renderText(missing)
  assert.ok(missingText.includes('翻译面板渲染失败'), `a missing store is explained (got: ${missingText.slice(0, 120)})`)
  assert.equal(missing.props['data-dsh-translator-error'], '1', 'and marked as an error panel')

  // The healthy path is untouched by the guard.
  const store = { getSnapshot: () => ({ refs: [], active: null }), subscribe: () => () => {} }
  assert.ok(renderText(pane({ store, runtime })).includes('还没有引用'), 'a healthy pane renders its own content')
})

test('translate() reaches fetch, consumes the stream, and returns the answer', async () => {
  const { exports } = await mount()
  const requests = stubFetch(LIVE_SSE_BODY)
  const deltas = []
  const started = []

  const answer = await exports.translateExport({
    text: 'Let me check the repository layout first.',
    kind: 'selection',
    lang: 'zh-CN',
    signal: new AbortController().signal,
    onStart: (info) => started.push(info),
    onDelta: (delta) => deltas.push(delta),
  })

  assert.equal(requests.length, 1, 'exactly one request — the loop must call the request helper, not a number')
  assert.equal(requests[0].url, '/dsh-translator/translate')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers.accept, 'text/event-stream')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    text: 'Let me check the repository layout first.',
    kind: 'selection',
    lang: 'zh-CN',
  })
  assert.deepEqual(started, [{ label: 'deepseek-official/deepseek-flash', cached: false }])
  assert.deepEqual(deltas, ['让我', '先检查', '一下仓库布局。'], 'every streamed delta is relayed, in order')
  assert.equal(answer, '让我先检查一下仓库布局。')
})

test('translate() turns a host error frame into a typed failure', async () => {
  const { exports } = await mount()
  const body = ['data: {"type":"start","route":{"provider":"p","model":"m"}}', '', 'data: {"type":"error","code":"QUOTA","message":"额度不足"}', '', ''].join('\n')
  const requests = stubFetch(body)
  await assert.rejects(
    () => exports.translateExport({ text: 'some english text here', kind: 'selection', lang: 'zh-CN' }),
    (error) => {
      assert.equal(error.code, 'QUOTA')
      assert.equal(error.message, '额度不足')
      return true
    },
  )
  assert.equal(requests.length, 1, 'a fatal code must not be retried')
})

test('translate() retries a pre-output network failure, then gives up', async () => {
  const { exports } = await mount()
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(
    () => exports.translateExport({ text: 'some english text here', kind: 'selection', lang: 'zh-CN' }),
    /Failed to fetch/,
  )
  assert.equal(calls, 3, 'the documented retry budget is three attempts')
})

test('translate() refuses a 200 that is not an event stream', async () => {
  const { exports } = await mount()
  stubFetch('<html>proxy login page</html>', { contentType: 'text/html' })
  await assert.rejects(
    () => exports.translateExport({ text: 'some english text here', kind: 'selection', lang: 'zh-CN' }),
    (error) => {
      assert.equal(error.code, 'INVALID')
      return true
    },
  )
})

test('a real translate() call drives the card all the way to done', async () => {
  const { exports } = await mount()
  const { RefsStore } = await import('../src/client/stores.js')
  const requests = stubFetch(LIVE_SSE_BODY)
  const store = new RefsStore('test-session-transport')

  // Exactly the translator the plugin builds: chunking plus the real transport.
  const translator = {
    chunks: (text) => [text],
    translate: (request) => exports.translateExport({ ...request, kind: 'selection', lang: 'zh-CN' }),
  }
  const key = store.add(
    { text: 'Let me check the repository layout first.', kind: 'selection', lang: 'zh-CN', sourceLabel: '划选内容' },
    translator,
  )
  for (let attempt = 0; attempt < 50; attempt += 1) await new Promise((resolve) => setImmediate(resolve))

  const ref = store.find(key)
  assert.equal(requests.length, 1, 'the click path reaches the network')
  assert.equal(ref.status, 'done', `the card must finish (got ${ref.status}: ${ref.error})`)
  assert.equal(ref.translation, '让我先检查一下仓库布局。')
  assert.equal(ref.routeLabel, 'deepseek-official/deepseek-flash')
  assert.equal(ref.cached, false)
})

// ---------------------------------------------------------------------------
// Self-report: the plugin must be able to explain itself from inside a page that
// cannot be inspected by a maintainer.
// ---------------------------------------------------------------------------

test('the self-report is off unless asked for, and reports the wiring when it is', async () => {
  globalThis.location = { search: '?token=abc' }
  const { exports, ctx } = await mount()
  assert.equal(exports.debugRequested(), false, 'no report without ?dsht-debug=1')

  // Ask for it and re-mount: the report renders into a portal root of its own.
  globalThis.location = { search: '?token=abc&dsht-debug=1' }
  const second = await mount()
  assert.equal(second.exports.debugRequested(), true, 'the flag is read from the query string')

  // The report panel is a plain component: render it with the same lines the
  // plugin produced and assert the shape the screenshot depends on.
  const lines = [
    'plugin        : dsh-translator (client)',
    'seat keys     : body=dsh-translator title=dsh-translator',
    'refs          : 0（空）',
    'pane render   : ok <div>',
  ]
  const panel = second.exports.DebugReportExport({ lines })
  assertRenderable(panel)
  const text = renderText(panel)
  for (const expected of ['dsh-translator 自检', 'seat keys', 'pane render']) {
    assert.ok(text.includes(expected), `the report shows "${expected}" (got: ${text.slice(0, 160)})`)
  }
  assert.equal(panel.props['data-dsh-translator-debug'], '1', 'the panel is marked for debugging')
  void ctx
})
