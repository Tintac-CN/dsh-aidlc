/**
 * `lib/aidlc/baseline.js` — F2: the test baseline and the regression comparison.
 *
 * The one rule that matters: **never fabricate `0 fail`**. Unparseable output,
 * a non-zero exit, a timeout and a spawn error must all be `unavailable`, never
 * a green zero. `compareBaseline` prefers case names, degrades to counts WITH a
 * disclosure line, and never drops a failure it cannot attribute.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBaseline, compareBaseline, parseTestOutput, recordBaseline } from '../lib/aidlc/baseline.js'

const F2 = ['ok  first case', 'ok  second case', 'FAIL third case', 'ALL 3'].join('\n')
const NODE_SPEC = ['ℹ tests 3', 'ℹ pass 2', 'ℹ fail 1', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', '✖ failing tests:', '✖ third case (2.5ms)'].join('\n')
const NODE_TAP = ['# tests 2', '# pass 1', '# fail 1', 'not ok 2 - second case'].join('\n')

test('parseTestOutput reads the native F2 grammar and cross-checks the ALL tail', () => {
  const parsed = parseTestOutput(F2)
  assert.equal(parsed.total, 3)
  assert.equal(parsed.pass, 2)
  assert.equal(parsed.fail, 1)
  assert.deepEqual(parsed.failingTests, ['third case'])
  assert.equal(parsed.format, 'f2')
  const mismatch = parseTestOutput(['ok  a', 'ALL 5'].join('\n'))
  assert.equal(mismatch.unavailable, true)
  assert.match(mismatch.why, /交叉核对不一致/)
})

test('parseTestOutput reads the Node spec and TAP summaries', () => {
  const spec = parseTestOutput(NODE_SPEC)
  assert.equal(spec.total, 3)
  assert.equal(spec.pass, 2)
  assert.equal(spec.fail, 1)
  assert.equal(spec.format, 'node-summary')
  assert.deepEqual(spec.failingTests, ['third case'], 'the "failing tests:" header is not a test name')
  const tap = parseTestOutput(NODE_TAP)
  assert.equal(tap.total, 2)
  assert.deepEqual(tap.failingTests, ['second case'])
})

test('SAFETY: parseTestOutput never fabricates a zero', () => {
  for (const text of ['', '   ', 'everything is fine, trust me', 'ok  a\nok  b\n(no tail line)', 'ℹ tests 3\nℹ pass 1\nℹ fail 1']) {
    const parsed = parseTestOutput(text)
    assert.equal(parsed.unavailable, true, JSON.stringify(text))
    assert.equal('fail' in parsed, false, JSON.stringify(text))
    assert.equal(typeof parsed.why, 'string')
  }
})

test('buildBaseline records unavailable (never a zero) for failed runs', () => {
  const failed = buildBaseline({ command: 'npm test', output: F2, exitCode: 1 })
  assert.equal(failed.unavailable, true)
  assert.equal(failed.fail, null)
  assert.match(failed.why, /非零退出/)
  assert.equal(buildBaseline({ command: 'x', output: F2, timedOut: true }).unavailable, true)
  assert.match(buildBaseline({ command: 'x', timedOut: true }).why, /超时/)
  assert.match(buildBaseline({ command: 'x', error: 'ENOENT' }).why, /执行失败/)
  const unparseable = buildBaseline({ command: 'x', output: 'no numbers here', previousSuites: ['a/b.test.js'] })
  assert.equal(unparseable.unavailable, true)
  assert.deepEqual(unparseable.suites, ['a/b.test.js'], 'the previous suite list is preserved so scope is not silently lost')
  const good = buildBaseline({ command: 'npm test', output: F2, recordedAt: '2026-10-20T00:00:00.000Z' })
  assert.deepEqual({ total: good.total, pass: good.pass, fail: good.fail, unavailable: good.unavailable }, { total: 3, pass: 2, fail: 1, unavailable: false })
  assert.equal(good.recordedAt, '2026-10-20T00:00:00.000Z')
})

test('recordBaseline writes in place and keeps the previous suites on a failed run', () => {
  const state = {}
  const same = recordBaseline(state, { command: 'npm test', output: F2 })
  assert.equal(same, state, 'in-place contract')
  assert.equal(state.testBaseline.total, 3)
  recordBaseline(state, { command: 'npm test', output: 'garbage' })
  assert.equal(state.testBaseline.unavailable, true)
  assert.equal(state.testBaseline.suites.length, 0)
})

test('compareBaseline: no baseline and unavailable baselines never read as pass', () => {
  const none = compareBaseline(null, { output: F2 })
  assert.equal(none.verdict, 'no-baseline')
  assert.equal(none.newFailures.length, 0)
  assert.match(none.note, /无基线对照/)
  const unavailable = compareBaseline({ unavailable: true, why: '超时' }, { output: F2 })
  assert.equal(unavailable.verdict, 'unavailable')
  assert.match(unavailable.note, /不得静默当作通过/)
  const badOutput = compareBaseline({ total: 3, pass: 3, fail: 0, format: 'f2' }, { output: 'nothing parseable' })
  assert.equal(badOutput.verdict, 'unavailable')
})

test('compareBaseline detects a regression by case name', () => {
  const baseline = parseTestOutput(F2)
  const clean = compareBaseline(baseline, { output: F2 })
  assert.equal(clean.verdict, 'pass')
  const regressed = compareBaseline(baseline, { output: ['ok  first case', 'FAIL second case', 'FAIL third case', 'ALL 3'].join('\n') })
  assert.equal(regressed.verdict, 'regression')
  assert.deepEqual(regressed.newFailures, ['second case'])
  assert.match(regressed.note, /BLOCKER/)
})

test('compareBaseline degrades to counts with an explicit disclosure', () => {
  const baseline = parseTestOutput(['ok  a', 'ok  b', 'ALL 2'].join('\n'))
  const regressed = compareBaseline(baseline, { output: ['ok  a', 'FAIL b', 'FAIL c', 'ALL 3'].join('\n') })
  assert.equal(regressed.verdict, 'regression')
  assert.equal(regressed.newFailures.length > 0, true)
  assert.match(regressed.note, /计数口径/)
  assert.match(regressed.note, /披露/)
})

test('compareBaseline never drops a failure it cannot attribute', () => {
  const baseline = { total: 1, pass: 1, fail: 0, format: 'f2', suites: ['src/a.test.js'] }
  const current = ['ok  src/a.test.js case', 'FAIL some anonymous case', 'ALL 2'].join('\n')
  const result = compareBaseline(baseline, { output: current })
  assert.equal(result.verdict, 'regression', 'an unattributable failure is compared, not excluded')
  assert.match(result.note, /无法归属/)
})

test('compareBaseline does not compare a suite added after the baseline (case-name basis)', () => {
  // the baseline must carry case names AND a suite list for the scope rule to apply
  const baseline = { ...parseTestOutput(['ok  src/a.test.js case', 'FAIL src/a.test.js old', 'ALL 2'].join('\n')), suites: ['src/a.test.js'] }
  assert.equal(baseline.fail, 1)
  const current = [
    'ok  src/a.test.js case',
    'FAIL src/a.test.js old',
    'FAIL src/brand-new.test.js case',
    'ALL 3',
  ].join('\n')
  const result = compareBaseline(baseline, { output: current })
  assert.equal(result.verdict, 'pass', 'the new suite is out of scope')
  assert.match(result.note, /未参与比对/)
  // and the fail-closed count fallback keeps an unattributable failure
  const countOnly = compareBaseline({ total: 1, pass: 1, fail: 0, format: 'f2', suites: ['src/a.test.js'] }, { output: current })
  assert.equal(countOnly.verdict, 'regression', 'count-only comparison cannot exclude, so it over-counts on purpose')
})

test('compareBaseline across grammars degrades to counts and discloses it', () => {
  const baseline = parseTestOutput(F2) // format f2, failingTests ['third case']
  const sameCounts = compareBaseline(baseline, { output: NODE_SPEC })
  assert.equal(sameCounts.verdict, 'pass', 'the counts agree: the same one failure')
  assert.match(sameCounts.note, /计数口径/)
  const worse = compareBaseline(baseline, { output: ['ℹ tests 3', 'ℹ pass 1', 'ℹ fail 2', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', '✖ another case (1ms)'].join('\n') })
  assert.equal(worse.verdict, 'regression')
  assert.match(worse.note, /计数口径/)
  assert.equal(worse.newFailures.length, 1)
})

test('a corrupted baseline with neither names nor a fail count is unavailable, not pass', () => {
  const result = compareBaseline({ total: null, pass: null, fail: null }, { output: F2 })
  assert.equal(result.verdict, 'unavailable')
  assert.match(result.note, /不得静默当作通过/)
})
