/**
 * Self-test for the pre-upgrade tripwire.
 *
 * The tool exists to catch ONE failure: a name this plugin binds to disappearing
 * from dsh. A tripwire nobody ever saw fire is not evidence, so this suite proves
 * it both passes on the real installation and MISSES when the name is gone — using
 * `settingsScope` as the known-removed specimen, because that is the exact binding
 * dsh 0.1.7-rc.2 deleted and the reason the whole Web GUI stopped booting.
 *
 * @module dsh-translator/test/compat
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { collectFilesForTest, declaredBindings, defaultRoots, findName, runCheck } from '../tools/check-dsh-compat.mjs'

const roots = defaultRoots()

test('declaredBindings reads the names from the BUILT bundles, not from a literal', async () => {
  const bindings = await declaredBindings()
  assert.deepEqual(bindings.services.sort(), ['llm', 'sidebarRight', 'sidebarRightTabs', 'slots', 'systemPrompt', 'uiSession', 'webServer'].sort())
  assert.deepEqual(bindings.slots, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.general.item'])
})

test('the tripwire is not vacuous: a name dsh really removed is reported MISSING', async () => {
  const files = await collectFilesForTest(roots[0])
  assert.ok(files.length > 100, `the scan must actually see the installation (got ${files.length} files)`)
  // The 0.1.7-rc.2 casualty. If this ever starts resolving, the scan has stopped
  // looking at real content and the tool has become a rubber stamp.
  assert.equal(await findName('settingsScope', files), undefined, 'settingsScope was deleted in 0.1.7 and must not be found')
  assert.ok(await findName('slots', files), 'a live service must be found')
})

test('runCheck passes against the installed dsh and reports every binding', async () => {
  const result = await runCheck(roots)
  assert.deepEqual(result.missing, [], `unexpected missing bindings: ${JSON.stringify(result.missing)}`)
  assert.equal(result.rows.length, 10, 'seven services plus three slots')
  assert.ok(result.roots.length >= 1, 'at least one dsh install root must be present')
})
