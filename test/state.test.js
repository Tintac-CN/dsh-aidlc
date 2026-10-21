/**
 * `lib/aidlc/state.js` — intent discovery, path classification, the two
 * overwrite invariants, the atomic write, the auto-route switch and the veto
 * window.
 *
 * Re-derived from the original `hooks/scripts/lib/state.mjs` plus the frozen
 * `docs/design.md` §4.2 contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PRESERVE_KEYS,
  activeIntentSummary,
  armVeto,
  checkOverwrite,
  findActiveIntent,
  isAidlcArtifactPath,
  isTestFile,
  isVetoPending,
  listIntents,
  loadIntent,
  newState,
  nowIso,
  readAutoRouteConfig,
  readJson,
  resolveVeto,
  routeEcho,
  slugOfPath,
  writeAutoRouteConfig,
  writeState,
} from '../lib/aidlc/state.js'
import { intent, intentDir, json, state, tmpRoot, write } from './helpers.mjs'

test('readJson never throws and never returns a non-object', (t) => {
  const root = tmpRoot(t)
  assert.equal(readJson(join(root, 'absent.json')), null)
  write(join(root, 'bad.json'), '{oops')
  assert.equal(readJson(join(root, 'bad.json')), null)
  write(join(root, 'array.json'), '[1,2]')
  assert.equal(readJson(join(root, 'array.json')), null)
  write(join(root, 'null.json'), 'null')
  assert.equal(readJson(join(root, 'null.json')), null)
  write(join(root, 'ok.json'), '{"a":1}')
  assert.deepEqual(readJson(join(root, 'ok.json')), { a: 1 })
})

test('slugOfPath is case-insensitive and keeps the original config.json quirk', () => {
  assert.equal(slugOfPath('docs/aidlc/my-intent/state.json'), 'my-intent')
  assert.equal(slugOfPath('Docs/AIDLC/My-Intent/plan.md'), 'My-Intent')
  assert.equal(slugOfPath('C:\\p\\docs\\aidlc\\x\\units\\U1.md'), 'x')
  assert.equal(slugOfPath('docs/aidlc/config.json'), 'config.json', 'quirk preserved: a file directly under docs/aidlc yields its own name')
  assert.equal(slugOfPath('src/app.js'), null)
  assert.equal(slugOfPath('docs/aidlc'), null)
})

test('isAidlcArtifactPath is about paths INSIDE an intent directory', () => {
  assert.equal(isAidlcArtifactPath('docs/aidlc/x/state.json'), true)
  assert.equal(isAidlcArtifactPath('docs/aidlc/config.json'), false)
  assert.equal(isAidlcArtifactPath('docs/aidlc/'), false)
  assert.equal(isAidlcArtifactPath('src/aidlc/x/y.md'), false)
})

test('isTestFile: every original pattern, plus non-test near-misses', () => {
  for (const p of [
    'tests/a.js', 'test/a.js', 'src/__tests__/a.js', 'spec/a.js', 'src/a.test.js', 'src/a.test.mjs',
    'src/a.spec.tsx', 'src/a.spec.js', 'pkg/test_thing.py', 'pkg/thing_test.py', 'pkg/thing_test.go',
    'pkg/thing_test.rs', 'pkg/thing_test.rb', 'pkg/thing_spec.rb', 'src/FooTest.java', 'src/FooTests.kt',
    'src/fooTest.cs', 'src/tests.java', 'C:\\repo\\src\\a.test.js',
  ]) {
    assert.equal(isTestFile(p), true, p)
  }
  for (const p of ['src/a.js', 'src/testing.js', 'testdata/a.json', 'src/latest.ts', 'contest/a.md', 'src/attest.js', 'spec.md']) {
    assert.equal(isTestFile(p), false, p)
  }
})

test('findActiveIntent ranks by updatedAt, skips done/archived and corrupt intents', (t) => {
  const root = tmpRoot(t)
  assert.equal(findActiveIntent(root), null, 'no docs/aidlc at all')
  intent(root, 'old', { stateOverrides: { updatedAt: '2026-01-01T00:00:00.000Z' } })
  intent(root, 'new', { stateOverrides: { updatedAt: '2026-09-01T00:00:00.000Z' } })
  assert.equal(findActiveIntent(root).slug, 'new')
  intent(root, 'finished', { stateOverrides: { phase: 'done', updatedAt: '2027-01-01T00:00:00.000Z' } })
  intent(root, 'terminated', { stateOverrides: { phase: 'archived', updatedAt: '2027-01-01T00:00:00.000Z' } })
  assert.equal(findActiveIntent(root).slug, 'new', 'done/archived are never active')
  const corrupt = intentDir(root, 'corrupt')
  write(join(corrupt, 'state.json'), 'not json')
  assert.equal(findActiveIntent(root).slug, 'new', 'a corrupt intent is skipped, not fatal')
  const noState = intentDir(root, 'nostate')
  write(join(noState, 'prd.md'), 'x')
  assert.equal(findActiveIntent(root).slug, 'new')
  // updatedAt missing -> mtime fallback still ranks it
  const dir = intentDir(root, 'mtime')
  write(join(dir, 'state.json'), json({ slug: 'mtime', phase: 'inception', gates: {} }))
  assert.equal(findActiveIntent(root).slug, 'mtime')
})

test('loadIntent refuses traversal and reports absence as null', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo')
  assert.equal(loadIntent(root, 'demo').slug, 'demo')
  assert.equal(loadIntent(root, 'nope'), null)
  assert.equal(loadIntent(root, '../demo'), null, 'a slug with a separator never resolves outside docs/aidlc')
  assert.equal(loadIntent(root, 'demo\\x'), null)
  assert.equal(loadIntent(root, ''), null)
  const corrupt = intentDir(root, 'broken')
  write(join(corrupt, 'state.json'), 'x')
  assert.equal(loadIntent(root, 'broken'), null)
})

test('listIntents returns corrupt intents with state:null and skips stateless dirs', (t) => {
  const root = tmpRoot(t)
  intent(root, 'a', { stateOverrides: { updatedAt: '2026-01-01T00:00:00.000Z' } })
  intent(root, 'b', { stateOverrides: { updatedAt: '2026-06-01T00:00:00.000Z', phase: 'done' } })
  const corrupt = intentDir(root, 'c')
  write(join(corrupt, 'state.json'), 'nope')
  intentDir(root, 'd')
  const all = listIntents(root)
  assert.deepEqual(all.map((i) => i.slug).sort(), ['a', 'b', 'c'])
  assert.equal(all.find((i) => i.slug === 'b').state.phase, 'done', 'done intents are listed')
  assert.equal(all.find((i) => i.slug === 'c').state, null, 'callers must null-check')
})

test('newState builds the documented skeleton and defaults the route to classic', () => {
  const s = newState({ slug: 'x', intent: 'do x' })
  assert.equal(s.slug, 'x')
  assert.equal(s.phase, 'inception')
  assert.deepEqual(s.gates, { gate1: 'pending', gate2: 'pending' })
  assert.equal(s.tddLock, false)
  assert.deepEqual(s.tddLockPaths, [])
  assert.equal(s.route, 'classic')
  assert.deepEqual(s.history, [])
  assert.equal(newState({ slug: 'x', route: 'express' }).route, 'express')
  assert.equal(newState({ slug: 'x', route: 'nonsense' }).route, 'classic')
  assert.equal('route' in newState({ slug: 'x', route: null }), false)
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/)
})

test('checkOverwrite names exactly what was lost', () => {
  const cur = state({ history: [{ at: 'A' }, { at: 'B' }], route: 'express', unitStatus: { U1: 'done' } })
  assert.deepEqual(checkOverwrite(null, {}), { ok: true })
  assert.deepEqual(checkOverwrite(cur, cur), { ok: true }, 'an unchanged state passes')
  const history = checkOverwrite(cur, state({ history: [{ at: 'A' }] }))
  assert.equal(history.ok, false)
  assert.equal(history.code, 'HISTORY_LOST')
  assert.match(history.message, /B/)
  const key = checkOverwrite(cur, state({ history: [{ at: 'A' }, { at: 'B' }], route: undefined }))
  assert.equal(key.code, 'KEY_DROPPED')
  assert.match(key.message, /route/)
  // an unparseable next state loses everything: the history check fires first
  const unparseable = checkOverwrite(cur, null)
  assert.equal(unparseable.code, 'HISTORY_LOST')
  // an empty `at` is not a history entry (original quirk) and does not count as lost
  assert.deepEqual(checkOverwrite(state({ history: [{ at: '' }] }), state({ history: [] })), { ok: true })
})

test('PRESERVE_KEYS is exactly the documented set and excludes the override', () => {
  assert.deepEqual([...PRESERVE_KEYS], ['route', 'testBaseline', 'unitStatus', 'tddLock', 'tddLockPaths'])
  assert.equal(PRESERVE_KEYS.includes('tddLockOverride'), false, 'clearing the override is the relock path')
})

test('writeState refuses to overwrite a corrupt state unless asked to repair it', (t) => {
  const root = tmpRoot(t)
  const dir = intentDir(root, 'broken')
  write(join(dir, 'state.json'), '{ nope')
  const refused = writeState(dir, state({ slug: 'broken' }))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'STATE_CORRUPT')
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{ nope', 'a refused write must not touch disk')
  const repaired = writeState(dir, state({ slug: 'broken' }), { allowRepair: true })
  assert.equal(repaired.ok, true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).slug, 'broken')
  assert.equal(writeState('', {}).code, 'NO_INTENT_DIR')
  assert.equal(writeState(dir, null).code, 'BAD_STATE')
})

test('writeState enforces the overwrite invariants and writes atomically', (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo')
  const lost = writeState(dir, state({ history: [] }))
  assert.equal(lost.ok, false)
  assert.equal(lost.code, 'HISTORY_LOST')
  const okWrite = writeState(dir, state({ history: [{ at: '2026-10-19T00:00:00.000Z', event: 'created' }], route: 'express' }))
  assert.equal(okWrite.ok, true)
  const text = readFileSync(join(dir, 'state.json'), 'utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(JSON.parse(text).route, 'express')
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'no temp file is left behind')
  // a brand-new intent directory is created on demand
  const fresh = join(root, 'docs', 'aidlc', 'created')
  assert.equal(writeState(fresh, state({ slug: 'created' })).ok, true)
  assert.equal(existsSync(join(fresh, 'state.json')), true)
})

test('the auto-route switch defaults off and preserves unrelated config keys', (t) => {
  const root = tmpRoot(t)
  assert.deepEqual(readAutoRouteConfig(root), { on: false, exists: false })
  assert.equal(writeAutoRouteConfig(root, true).ok, true)
  assert.deepEqual(readAutoRouteConfig(root), { on: true, exists: true })
  // a hand-written config with another key survives the toggle
  write(join(root, 'docs', 'aidlc', 'config.json'), json({ autoRouting: true, note: 'keep me' }))
  assert.deepEqual(readAutoRouteConfig(root), { on: true, exists: true })
  writeAutoRouteConfig(root, false)
  const cfg = readJson(join(root, 'docs', 'aidlc', 'config.json'))
  assert.equal(cfg.autoRouting, false)
  assert.equal(cfg.note, 'keep me')
  assert.match(cfg.updatedAt, /^\d{4}-/)
  // malformed means OFF, never throw
  write(join(root, 'docs', 'aidlc', 'config.json'), 'not json')
  assert.deepEqual(readAutoRouteConfig(root), { on: false, exists: true })
})

test('routeEcho is three-state and never branches on the value elsewhere', () => {
  assert.equal(routeEcho({ route: 'express' }), 'route=express')
  assert.equal(routeEcho({ route: 'classic' }), 'route=classic')
  assert.equal(routeEcho({ route: 'turbo' }), 'route=turbo(invalid→classic)')
  assert.equal(routeEcho({}), null)
  assert.equal(routeEcho({ route: null }), null)
})

test('activeIntentSummary stays useful when state.json is corrupt', () => {
  assert.equal(activeIntentSummary(null), null)
  assert.match(activeIntentSummary({ slug: 'x', state: null }), /cannot be parsed/)
  const line = activeIntentSummary({
    slug: 'x',
    state: { phase: 'construction', gates: { gate1: 'approved' }, tddLock: true, tddLockOverride: { at: 'a' }, unitStatus: { U1: 'done', U2: 'todo' }, route: 'express' },
  })
  assert.match(line, /phase: construction/)
  assert.match(line, /gate1=approved/)
  assert.match(line, /TDD-LOCK=on/)
  assert.match(line, /TDD-OVERRIDE=on/)
  assert.match(line, /units 1\/2 done/)
  assert.match(line, /route=express/)
})

test('the veto window: arm, resolve, and expiry', () => {
  const armed = armVeto(state(), { decision: { choice: 'Approve' }, vetoUntil: '2026-10-20T00:10:00.000Z', by: 'systemone', confidence: 0.9 })
  assert.equal(armed.veto.status, 'armed')
  assert.equal(armed.veto.reversed, false)
  assert.equal(state().veto, undefined, 'armVeto is pure')
  assert.equal(isVetoPending(armed, '2026-10-20T00:05:00.000Z'), true)
  assert.equal(isVetoPending(armed, '2026-10-20T00:20:00.000Z'), false)
  assert.equal(isVetoPending(state()), false)
  const vetoed = resolveVeto(armed, { veto: 'vetoed', at: '2026-10-20T00:05:00.000Z', note: 'wrong call' })
  assert.equal(vetoed.veto.status, 'vetoed')
  assert.equal(vetoed.veto.reversed, true)
  assert.equal(vetoed.veto.resolution, 'substitution-vetoed')
  assert.equal(isVetoPending(vetoed), false, 'a resolved veto is no longer pending')
  const upheld = resolveVeto(armed, { veto: 'upheld' })
  assert.equal(upheld.veto.reversed, false)
  assert.equal(upheld.veto.resolution, 'substitution-upheld')
  assert.equal(resolveVeto(armed, { veto: 'maybe' }), null, 'an unresolvable veto is never silently recorded')
  assert.equal(resolveVeto(state(), { veto: 'upheld' }), null)
  assert.equal(resolveVeto(armed, { veto: 'upheld' }).veto.note, '')
  // no deadline at all: armed forever
  assert.equal(isVetoPending(armVeto(state(), { decision: { choice: 'x' } })), true)
  // an unparseable deadline stays pending (fail-closed on reversibility)
  assert.equal(isVetoPending(armVeto(state(), { decision: { choice: 'x' }, vetoUntil: 'whenever' })), true)
  assert.equal(armVeto(null, { decision: {} }), null)
  assert.equal(armVeto(state(), {}), null)
})
