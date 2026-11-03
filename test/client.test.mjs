import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Seam test for the client half.
 *
 * The shell does not `import` this file: it takes the source, runs it with a `window`
 * shim and lets `__ModuleLoader__.load` capture the envelope, then calls `factory(require)`
 * and `apply(ctx)`. A unit test that only checks the source text would pass while the
 * bundle fails to load (that is exactly how this profile crashed on 2026-10-29), so this
 * test repeats the shell's contract: eval → capture → factory → apply → registration.
 */

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

function loadEnvelope() {
  let captured = null
  const windowShim = {
    __ModuleLoader__: {
      load(envelope) {
        if (captured !== null) throw new Error('load() called twice')
        captured = envelope
      },
    },
  }
  const head = { appendChild() {} }
  const documentShim = {
    head,
    documentElement: head,
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', source)(windowShim, documentShim, undefined)
  return captured
}

function reactStub() {
  return {
    createElement: (...args) => ({ args }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  }
}

test('client.js loads through the module loader contract and announces its own id', () => {
  const envelope = loadEnvelope()
  assert.ok(envelope !== null, 'window.__ModuleLoader__.load must be called exactly once')
  assert.equal(envelope.id, 'dsh-capability-ledger')
  assert.equal(typeof envelope.factory, 'function')
})

test('the factory only needs react and exposes slots + layout injection', () => {
  const envelope = loadEnvelope()
  const required = []
  const mod = envelope.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return reactStub()
    throw new Error(`client.js required an unexpected module: ${specifier}`)
  })
  assert.deepEqual([...new Set(required)], ['react'])
  assert.deepEqual(mod.inject, ['slots', 'layout'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply registers a sidebar action and the keyed main panel, and injects the styles once', () => {
  const envelope = loadEnvelope()
  const mod = envelope.factory(() => reactStub())

  const styles = []
  const injected = []
  const registrations = []
  const ctx = {
    effect(factory) {
      const dispose = factory()
      assert.equal(typeof dispose, 'function', 'effect factories must return a disposer')
      styles.push(dispose)
      return dispose
    },
    slots: {
      inject(name, register) {
        injected.push(name)
        register()
      },
      register(definition, component) {
        registrations.push({ definition, component })
      },
    },
    layout: {
      selected: null,
      selectPanel(key) {
        this.selected = key
      },
    },
  }

  mod.apply(ctx)

  assert.deepEqual([...injected].sort(), ['main', 'sidebar.footer.action'])
  assert.equal(registrations.length, 2)

  const action = registrations.find((entry) => entry.definition.name === 'sidebar.footer.action')
  assert.equal(action.definition.id, 'capability-ledger-action')
  assert.equal(typeof action.definition.label, 'function')
  assert.equal(typeof action.component, 'function')

  const panel = registrations.find((entry) => entry.definition.name === 'main')
  assert.equal(panel.definition.key, 'capability-ledger')
  assert.equal(typeof panel.component, 'function')

  // The action opens the page by key — the same call the shell's sidebar makes.
  // The React stub returns { args: [type, props] }, so props sit at index 1.
  const trigger = action.component()
  trigger.args[1].onClick()
  assert.equal(ctx.layout.selected, 'capability-ledger')

  assert.equal(styles.length, 1)
})
