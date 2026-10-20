/**
 * `guardWrite` — Rules 1–7 of the original `guard-gates.mjs`, each with an allow
 * case, a deny case and at least one near-miss that must NOT deny.
 *
 * Rules re-derived from the original source, not from the port's summary:
 *   1 construction artifacts need gate1 approved; 2 TDD lock (scoped by
 *   `tddLockPaths`, whole repo when empty); 3 gate receipts; 4 history optimistic
 *   lock + preserve-keys; 5 ledger append-only; 6 state.json/decisions.md are
 *   Write-only; 7 F4 coverage at the phase→gate1 transition; plus the
 *   fail-closed corrupt-state branch and the brand-new-intent branch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardPaths, guardWrite } from '../lib/aidlc/guards.js'
import { intent, intentDir, json, state, tmpRoot, write } from './helpers.mjs'

const gw = (root, filePath, content, extra = {}) => guardWrite({ filePath, content, root, ...extra })
const ok = (d) => d.kind === 'allow' || d.kind === 'allow-with-disclosure'

/* ─────────────────────────── Rule 1: Construction ─────────────────────────── */

test('Rule 1: plan.md and units/** are denied before gate1, allowed after', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending', gate2: 'pending' } }, ledgerText: null })
  for (const file of ['docs/aidlc/demo/plan.md', 'docs/aidlc/demo/units/U1.md', 'docs/aidlc/demo/units/sub/deep.md']) {
    const denied = gw(root, file, 'x')
    assert.equal(denied.kind, 'deny', file)
    assert.match(denied.reason, /Gate#1 未通过/)
  }
  // with gate1 approved the same writes pass
  intent(root, 'demo', { stateOverrides: { phase: 'construction', gates: { gate1: 'approved' } } })
  for (const file of ['docs/aidlc/demo/plan.md', 'docs/aidlc/demo/units/U1.md']) {
    assert.ok(ok(gw(root, file, 'x')), file)
  }
})

test('Rule 1 near-misses that must NOT deny', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending', gate2: 'pending' } }, ledgerText: null })
  // `units\/` requires the slash: `units-old/` and a bare `units` file are not matched (quirk preserved)
  assert.ok(ok(gw(root, 'docs/aidlc/demo/units-old/U1.md', 'x')))
  assert.ok(ok(gw(root, 'docs/aidlc/demo/units', 'x')))
  assert.ok(ok(gw(root, 'docs/aidlc/demo/plans/plan.md', 'x')), 'a directory named plans/ is not plan.md')
  assert.ok(ok(gw(root, 'docs/aidlc/demo/notes.md', 'x')))
  assert.ok(ok(gw(root, 'src/app.js', 'x')), 'paths outside docs/aidlc are untouched')
})

/* ────────────────────────────── Rule 2: TDD lock ──────────────────────────── */

test('Rule 2: the lock denies only the files inside tddLockPaths', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { tddLock: true, tddLockPaths: ['src/a.test.js'] } })
  assert.equal(gw(root, 'src/a.test.js', 'x').kind, 'deny')
  assert.ok(ok(gw(root, 'src/b.test.js', 'x')), 'a sibling test file is out of scope')
  assert.ok(ok(gw(root, 'src/a.js', 'x')), 'a non-test file in scope is not locked')
  assert.equal(gw(root, 'sub/dir/src/a.test.js', 'x').kind, 'deny', 'suffix match')
  assert.equal(gw(root, 'SRC/A.TEST.JS', 'x').kind, 'deny', 'case-insensitive on normalised paths')
  assert.equal(gw(root, 'src\\a.test.js', 'x').kind, 'deny', 'windows separators are normalised')
})

test('Rule 2: an empty/missing path list locks every test file in the repo', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { tddLock: true, tddLockPaths: [] } })
  assert.equal(gw(root, 'anywhere/foo.spec.ts', 'x').kind, 'deny')
  assert.equal(gw(root, 'tests/x.py', 'x').kind, 'deny')
  assert.ok(ok(gw(root, 'anywhere/foo.ts', 'x')))
  intent(root, 'demo', { stateOverrides: { tddLock: true, tddLockPaths: undefined } })
  assert.equal(gw(root, 'anywhere/foo.test.js', 'x').kind, 'deny')
})

test('Rule 2: tddLockOverride opens the window; lock off ignores scope', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { tddLock: true, tddLockPaths: [], tddLockOverride: { at: '2026-10-20', reason: 'contract bug' } } })
  assert.ok(ok(gw(root, 'src/a.test.js', 'x')))
  intent(root, 'demo', { stateOverrides: { tddLock: false, tddLockPaths: ['src/a.test.js'] } })
  assert.ok(ok(gw(root, 'src/a.test.js', 'x')))
})

/* ────────────────────── Rule 6 / 6b: Write-only files ─────────────────────── */

test('Rule 6: Edit is denied for state.json and decisions.md, allowed elsewhere', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { gates: { gate1: 'approved' } } })
  for (const file of ['docs/aidlc/demo/state.json', 'docs/aidlc/demo/decisions.md']) {
    const denied = gw(root, file, undefined, { isEdit: true })
    assert.equal(denied.kind, 'deny', file)
    assert.match(denied.reason, /禁止用 Edit 修改/)
  }
  assert.ok(ok(gw(root, 'docs/aidlc/demo/plan.md', undefined, { isEdit: true })), 'an Edit of another artifact is a normal write')
})

test('Rule 6b: a Write with no content cannot rewrite an existing audited file', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo')
  for (const file of ['docs/aidlc/demo/state.json', 'docs/aidlc/demo/decisions.md']) {
    const denied = gw(root, file, undefined)
    assert.equal(denied.kind, 'deny', file)
    assert.match(denied.reason, /没有携带完整文件内容/)
  }
  // creation still works, because there is nothing to lose
  assert.ok(ok(gw(root, 'docs/aidlc/other/state.json', undefined)))
})

/* ───────────────────────── Rule 4: optimistic lock ────────────────────────── */

test('Rule 4a: an overwrite may not drop a history entry', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo')
  const denied = gw(root, 'docs/aidlc/demo/state.json', json(state({ history: [] })))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /乐观锁/)
  // reordered but complete history passes
  const kept = state({ history: [{ event: 'created', at: '2026-10-19T00:00:00.000Z' }] })
  assert.ok(ok(gw(root, 'docs/aidlc/demo/state.json', json(kept))))
})

test('Rule 4b: an overwrite may not drop or null a preserve-key, but may change its value', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { route: 'classic', testBaseline: { total: 3 }, unitStatus: { U1: 'done' }, tddLock: true } })
  for (const [label, next] of [
    ['route dropped', { route: undefined }],
    ['route nulled', { route: null }],
    ['testBaseline nulled', { testBaseline: null }],
    ['unitStatus dropped', { unitStatus: undefined }],
    ['tddLock false is KEPT, dropping it is not', { tddLock: undefined }],
  ]) {
    const denied = gw(root, 'docs/aidlc/demo/state.json', json(state(next)))
    assert.equal(denied.kind, 'deny', label)
    assert.match(denied.reason, /键保留校验/)
  }
  assert.ok(ok(gw(root, 'docs/aidlc/demo/state.json', json(state({ route: 'express', testBaseline: { total: 5 }, unitStatus: { U1: 'pending' }, tddLock: false })))), 'value changes pass')
})

test('Rule 4b near-miss: dropping a key the current state never had is not a drop', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { route: undefined, testBaseline: undefined, unitStatus: undefined } })
  assert.ok(ok(gw(root, 'docs/aidlc/demo/state.json', json(state({ route: undefined, testBaseline: undefined, unitStatus: undefined })))))
})

/* ──────────────────────── Rule 5: append-only ledger ──────────────────────── */

test('Rule 5: decisions.md may only be extended verbatim', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { ledgerText: 'A\nB\n' })
  assert.ok(ok(gw(root, 'docs/aidlc/demo/decisions.md', 'A\nB\nC\n')))
  assert.ok(ok(gw(root, 'docs/aidlc/demo/decisions.md', 'A\nB\n')), 'an idempotent rewrite is still a prefix')
  for (const [label, text] of [['reordered', 'B\nA\n'], ['truncated', 'A\n'], ['mutated', 'A\nB2\n'], ['trailing space added', 'A\nB \n']]) {
    const denied = gw(root, 'docs/aidlc/demo/decisions.md', text)
    assert.equal(denied.kind, 'deny', label)
    assert.match(denied.reason, /只追加/)
  }
  // creation is exempt
  assert.ok(ok(gw(root, 'docs/aidlc/newintent/decisions.md', 'fresh\n')))
})

/* ────────────────────── corrupt state: fail closed ────────────────────────── */

test('corrupt state.json fails closed for every path except its own repair', (t) => {
  const root = tmpRoot(t)
  const dir = intentDir(root, 'broken')
  write(join(dir, 'state.json'), '{ this is not json')
  const denied = gw(root, 'docs/aidlc/broken/prd.md', 'x')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /存在但无法解析/)
  assert.equal(gw(root, 'docs/aidlc/broken/state.json', undefined, { isEdit: true }).kind, 'deny')
  assert.ok(ok(gw(root, 'docs/aidlc/broken/state.json', json({ slug: 'broken', phase: 'inception', gates: { gate1: 'pending' }, history: [] }))), 'the repair Write is allowed')
  // ...but a repair that claims an approval still needs the receipt
  const claimed = gw(root, 'docs/aidlc/broken/state.json', json({ slug: 'broken', phase: 'gate1', gates: { gate1: 'approved' }, history: [] }))
  assert.equal(claimed.kind, 'deny')
  assert.match(claimed.reason, /缺少有效的人类审批回执/)
  // an unrelated intent is unaffected by another intent's corruption
  intent(root, 'healthy', { stateOverrides: { gates: { gate1: 'approved' } } })
  assert.ok(ok(gw(root, 'docs/aidlc/healthy/prd.md', 'x')))
})

/* ───────────────────── brand-new intent / bypass-a ────────────────────────── */

test('a brand-new intent: plain creation passes, a first write claiming gate1 does not', (t) => {
  const root = tmpRoot(t)
  assert.ok(ok(gw(root, 'docs/aidlc/fresh/state.json', json({ slug: 'fresh', phase: 'inception', gates: { gate1: 'pending' }, history: [] }))))
  const claimed = gw(root, 'docs/aidlc/fresh/state.json', json({ slug: 'fresh', phase: 'gate1', gates: { gate1: 'approved' }, history: [] }))
  assert.equal(claimed.kind, 'deny', 'bypass-a: deleting state.json must not dodge the receipt rule')
  assert.match(claimed.reason, /缺少有效的人类审批回执/)
  const phased = gw(root, 'docs/aidlc/fresh/state.json', json({ slug: 'fresh', phase: 'gate1', gates: { gate1: 'pending' }, history: [] }))
  assert.equal(phased.kind, 'deny', 'the phase→gate1 transition is F4-checked even on a first write')
  assert.match(phased.reason, /F4/)
})

test('D12 (port deviation): a stateless intent cannot receive Construction artifacts', (t) => {
  const root = tmpRoot(t)
  // The ORIGINAL allowed every non-state.json path here, so a fresh — or
  // state.json-deleted — intent directory could receive plan.md / units/** before
  // Gate#1 (migration-map §6/N8). The port closes that hole (guards.js header D12).
  for (const file of ['docs/aidlc/ghost/plan.md', 'docs/aidlc/ghost/units/U1.md']) {
    const denied = gw(root, file, 'x')
    assert.equal(denied.kind, 'deny', file)
    assert.match(denied.reason, /没有可解析的 state\.json/)
  }
  // ...and must NOT deadlock intent creation: these stay writable
  for (const file of [
    'docs/aidlc/ghost/state.json',
    'docs/aidlc/ghost/intent.md',
    'docs/aidlc/ghost/prd.md',
    'docs/aidlc/ghost/test-strategy.md',
    'docs/aidlc/ghost/decisions.md',
    'docs/aidlc/ghost/reviews/gate1-ai.md',
    'docs/aidlc/ghost/architecture.md',
  ]) {
    assert.ok(ok(gw(root, file, 'x')), file)
  }
  // the deviation is narrow: with the flag off, the original permissiveness returns
  assert.ok(ok(gw(root, 'docs/aidlc/ghost/plan.md', 'x', { config: { constructionGate: false } })))
})

/* ───────────────────────── config stand-down ──────────────────────────────── */

test('guard flags: an absent config keeps every rule enabled, a flag disables only its rule', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending' }, tddLock: true, tddLockPaths: [] }, ledgerText: null })
  assert.equal(gw(root, 'docs/aidlc/demo/plan.md', 'x', { config: undefined }).kind, 'deny')
  assert.equal(gw(root, 'docs/aidlc/demo/plan.md', 'x', { config: {} }).kind, 'deny')
  assert.ok(ok(gw(root, 'docs/aidlc/demo/plan.md', 'x', { config: { constructionGate: false } })))
  assert.equal(gw(root, 'src/a.test.js', 'x', { config: { constructionGate: false } }).kind, 'deny', 'a partial config must not stand the other rules down')
  assert.ok(ok(gw(root, 'src/a.test.js', 'x', { config: { tddLock: false } })))
})

test('secret paths are denied before any gate rule, and the flag can stand them down', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending' } }, ledgerText: null })
  const denied = gw(root, '.env', 'x')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /environment\/secret file/)
  assert.ok(ok(gw(root, '.env', 'x', { config: { protectedPaths: false } })))
  assert.equal(guardPaths({ filePath: '.env' }).kind, 'deny')
})

/* ─────────────────────────── path resolution ──────────────────────────────── */

test('absolute paths are normalised and guarded like relative ones', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending' } }, ledgerText: null })
  const abs = join(root, 'docs', 'aidlc', 'demo', 'plan.md')
  const denied = gw(root, abs, 'x')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /Gate#1 未通过/)
  assert.ok(ok(gw(root, join(root, 'docs', 'aidlc', 'demo', 'prd.md'), 'x')))
  const win = gw(root, 'docs\\aidlc\\demo\\plan.md', 'x')
  assert.equal(win.kind, 'deny', 'windows separators')
})

test('guardWrite takes one options object and allows when it has nothing to guard', () => {
  // guardWrite has no tool-name input: index.js decides which tools are file
  // writes. This pins the signature so a refactor cannot silently add one.
  assert.deepEqual(guardWrite(), { kind: 'allow' }, 'no input = nothing to guard = allow')
  assert.ok(ok(guardWrite({ filePath: 'README.md' })))
})

test('a docs/aidlc path with no intent and no state.json is not silently denied', (t) => {
  const root = tmpRoot(t)
  mkdirSync(join(root, 'docs', 'aidlc', 'config.json'), { recursive: true })
  assert.ok(ok(gw(root, 'docs/aidlc/config.json', '{}')), 'the slugOfPath quirk resolves to config.json, which has no state.json')
  assert.ok(ok(gw(root, 'README.md', 'x')))
})
