/**
 * `lib/decision/arbiter.js` — the attack battery.
 *
 * The properties under attack, from docs/design.md §5/§7.1 and
 * docs/decision-model.md §2/§6/§8/§12:
 *   - the arbiter NEVER starts or races a human ask (Point A pre-empt / Point B
 *     post-timeout only);
 *   - `advisory` never unblocks; Point B never returns an answer;
 *   - every failure mode is fail-closed (`source:'none'`, `answer:null`);
 *   - NEVER_AUTO cannot be configured into substitution;
 *   - a model answer is only usable if it names an offered option;
 *   - exactly one audit record per invocation, on every path;
 *   - a substitution that cannot be audited is withdrawn.
 *
 * All transports are in-process fakes. Nothing here touches the network, the
 * clock or the filesystem.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { arbitrate, probabilityStats, shapedAnswer, validateModelAnswer } from '../lib/decision/arbiter.js'
import { NEVER_AUTO } from '../lib/decision/policy.js'

const LABELS = ['Approve', 'Reject']
const request = (extra = {}) => ({ id: 'q1', question: 'Proceed with the tweak?', options: LABELS.map((label) => ({ label })), ...extra })
const config = (extra = {}) => ({ classes: { 'artifact.tweak': 'substitute', 'unit.ordering': 'substitute' }, ...extra })

const answer = (overrides = {}) => ({ choice: 'Approve', confidence: 0.95, risk: 'low', ...overrides })

/** Run one arbitration, counting model calls and audit records. Any askHuman call throws. */
async function run({ deps: overrides = {}, ...input } = {}) {
  const records = []
  let modelCalls = 0
  const consultModel = overrides.consultModel
    ? async (...args) => {
        modelCalls += 1
        return overrides.consultModel(...args)
      }
    : async () => {
        modelCalls += 1
        return answer()
      }
  const result = await arbitrate({
    request: request(),
    decisionClass: 'artifact.tweak',
    deps: {
      askHuman: () => {
        throw new Error('askHuman must never be called: there is no human race')
      },
      consultModel,
      record: (entry) => records.push(entry),
      now: () => 1_000_000,
      ...overrides,
      // keep the real transport wrapped even when the caller replaced it
      ...(overrides.consultModel ? { consultModel } : {}),
    },
    config: config(),
    ...input,
  })
  return { result, records, modelCalls }
}

/* ─────────────────────────── the never-auto clamp ──────────────────────────── */

test('SAFETY: a never-auto class never substitutes, whatever the config or the caller asks', async () => {
  for (const decisionClass of NEVER_AUTO) {
    const { result, modelCalls } = await run({
      decisionClass,
      prefer: 'model-first',
      complexity: 'trivial',
      config: { classes: Object.fromEntries([...NEVER_AUTO].map((id) => [id, 'substitute'])) },
    })
    assert.equal(result.substituted, false, decisionClass)
    assert.equal(result.answer, null, decisionClass)
    assert.notEqual(result.mode, 'substitute', decisionClass)
    if (result.mode === 'hold') assert.equal(modelCalls, 0, `${decisionClass} in hold must not even consult the model`)
  }
})

test('SAFETY: an unknown class id resolves to hold and is audited as such', async () => {
  const { result, modelCalls } = await run({ decisionClass: 'made.up', prefer: 'model-first', config: { classes: { 'made.up': 'substitute' } } })
  assert.equal(result.mode, 'hold')
  assert.equal(result.source, 'none')
  assert.equal(result.code, 'unknown-class')
  assert.equal(modelCalls, 0)
  assert.equal(result.record.class_unknown, true)
})

test('the decision layer being disabled means hold, with no model call', async () => {
  const { result, modelCalls } = await run({ prefer: 'model-first', config: config({ enabled: false }) })
  assert.equal(result.code, 'hold')
  assert.equal(result.substituted, false)
  assert.equal(modelCalls, 0)
})

/* ──────────────────────── Point A / Point B semantics ─────────────────────── */

test('Point A: a confident substitute verdict is applied and returns a shaped answer', async () => {
  const { result, records } = await run({ prefer: 'model-first', complexity: 'trivial' })
  assert.equal(result.source, 'model')
  assert.equal(result.substituted, true)
  assert.equal(result.applicable, true)
  assert.deepEqual(result.answer, shapedAnswer(request(), 'Approve'))
  assert.equal(result.code, 'substituted')
  assert.equal(result.record.trigger, 'preempt')
  assert.equal(records.length, 1)
  assert.equal(result.record.veto_until, 1_000_000 + 600_000, 'the veto window opens from the decision instant')
})

test('Point B: applicable, recorded — and NEVER an answer for the settled call', async () => {
  const { result, records } = await run({ prefer: 'timeout-fallback', humanTimedOut: true, complexity: 'trivial' })
  assert.equal(result.applicable, true, 'the verdict cleared every gate, for the lifecycle to act on')
  assert.equal(result.substituted, false, 'Point B never substitutes the tool call')
  assert.equal(result.answer, null, 'no answer may be fabricated for a finished call')
  assert.equal(result.code, 'timeout-verdict')
  assert.equal(result.record.trigger, 'timeout')
  assert.equal(records.length, 1)
  assert.equal(result.record.veto_until, null, 'nothing was applied, so there is nothing to veto')
})

test('SECURITY: no lane ever returns an answer with substituted !== true', async () => {
  const cases = [
    { prefer: 'timeout-fallback', humanTimedOut: true },
    { prefer: 'model-first', config: config({ classes: { 'artifact.tweak': 'advisory' } }) },
    { prefer: 'model-first', config: config({ onLowConfidence: 'advisory' }), deps: { consultModel: async () => answer({ confidence: 0.1 }) } },
    { prefer: 'model-first', config: config({ onLowConfidence: 'defer-model' }), deps: { consultModel: async () => answer({ confidence: 0.1 }) } },
    { prefer: 'model-first', complexity: 'complex' },
  ]
  for (const [i, input] of cases.entries()) {
    const { result } = await run(input)
    if (result.answer !== null) assert.equal(result.substituted, true, `case ${i}`)
    if (result.substituted !== true) assert.equal(result.answer, null, `case ${i}`)
  }
})

test('advisory mode records the verdict and stays blocked', async () => {
  const { result, records } = await run({ prefer: 'model-first', config: config({ classes: { 'artifact.tweak': 'advisory' } }) })
  assert.equal(result.source, 'model', 'the model opinion is recorded')
  assert.equal(result.advisory, true)
  assert.equal(result.substituted, false)
  assert.equal(result.applicable, false)
  assert.equal(result.answer, null)
  assert.equal(result.code, 'advisory-only')
  assert.equal(records[0].requires_post_hoc_review, true)
})

test('arbitrate never calls askHuman on either lane', async () => {
  // the `run` helper's askHuman throws; if it were called, these would reject
  await run({ prefer: 'model-first' })
  await run({ prefer: 'timeout-fallback', humanTimedOut: true })
  await run({ decisionClass: 'test.unlock', prefer: 'model-first' })
  assert.ok(true)
})

/* ─────────────────────────── the confidence gate ──────────────────────────── */

test('the threshold is a floor: exactly at the bar substitutes, just below blocks', async () => {
  // generic.question carries no band floor; artifact.tweak would put the bar at
  // 0.85 and this test is about the OPERATOR threshold, not the class floor.
  const at = await run({ decisionClass: 'generic.question', prefer: 'model-first', complexity: 'trivial', deps: { consultModel: async () => answer({ confidence: 0.6 }) } })
  assert.equal(at.result.substituted, true, '0.6 clears a 0.6 bar')
  const below = await run({ decisionClass: 'generic.question', prefer: 'model-first', complexity: 'trivial', deps: { consultModel: async () => answer({ confidence: 0.599 }) } })
  assert.equal(below.result.substituted, false)
  assert.equal(below.result.source, 'none')
  assert.equal(below.result.code, 'low-confidence')
  assert.equal(below.result.answer, null)
})

test('the C-level bars are enforced (C2/C3 need 0.85)', async () => {
  const c2 = await run({ prefer: 'model-first', complexity: 'simple', deps: { consultModel: async () => answer({ confidence: 0.7 }) } })
  assert.equal(c2.result.substituted, false)
  assert.equal(c2.result.code, 'low-confidence')
  const c2ok = await run({ prefer: 'model-first', complexity: 'simple', deps: { consultModel: async () => answer({ confidence: 0.86 }) } })
  assert.equal(c2ok.result.substituted, true)
  const raised = await run({ prefer: 'model-first', complexity: 'trivial', config: config({ confidenceThreshold: 0.9 }), deps: { consultModel: async () => answer({ confidence: 0.8 }) } })
  assert.equal(raised.result.substituted, false, 'the operator floor is a floor under every level')
})

test('a high-risk verdict faces the 0.85 bar whatever its level', async () => {
  const blocked = await run({ prefer: 'model-first', complexity: 'trivial', deps: { consultModel: async () => answer({ confidence: 0.7, risk: 'high' }) } })
  assert.equal(blocked.result.substituted, false)
  assert.equal(blocked.result.code, 'low-confidence')
  const allowed = await run({ prefer: 'model-first', complexity: 'trivial', deps: { consultModel: async () => answer({ confidence: 0.86, risk: 'high' }) } })
  assert.equal(allowed.result.substituted, true)
})

test('the gate is on p_max, not the transport confidence field', async () => {
  const high = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ confidence: 0.2, probabilities: { Approve: 0.9, Reject: 0.1 } }) } })
  assert.equal(high.result.substituted, true)
  assert.equal(high.records[0].p_max, 0.9)
  assert.equal(high.records[0].gate_value, 0.9)
  assert.equal(high.records[0].confidence, 0.2)
  const low = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ confidence: 0.99, probabilities: { Approve: 0.55, Reject: 0.45 } }) } })
  assert.equal(low.result.substituted, false, 'a self-reported 0.99 cannot lift a 0.55 p_max over the bar')
  // an inflated probability for an option nobody offered never raises the gate value
  const inflated = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ confidence: 0.1, probabilities: { Approve: 0.2, Evil: 0.99 } }) } })
  assert.equal(inflated.result.substituted, false)
  assert.deepEqual(inflated.records[0].probabilities, { Approve: 0.2 })
})

/* ─────────────────────────── critical / self-doubt ────────────────────────── */

test('critical risk is never applied with the default config, whatever the choice', async () => {
  for (const choice of ['Approve', 'Reject']) {
    const { result } = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ confidence: 0.99, risk: 'critical', choice }) } })
    assert.equal(result.substituted, false, choice)
    assert.equal(result.code, 'critical-risk')
  }
})

test('critical risk can never ALLOW even with blockOnCriticalRisk=false', async () => {
  const { result } = await run({
    prefer: 'model-first',
    config: config({ blockOnCriticalRisk: false }),
    deps: { consultModel: async () => answer({ confidence: 0.99, risk: 'critical', choice: 'Approve' }) },
  })
  assert.equal(result.substituted, false)
  assert.equal(result.code, 'critical-allow')
  for (const permissive of ['yes', 'OK', 'proceed', 'go ahead', 'Enabled', 'ship it', 'APPROVED']) {
    const { result: r } = await run({
      prefer: 'model-first',
      config: config({ blockOnCriticalRisk: false }),
      deps: { consultModel: async () => answer({ confidence: 0.99, risk: 'critical', choice: permissive }) },
    })
    assert.equal(r.substituted, false, permissive)
  }
})

test('a self-doubting transport never substitutes', async () => {
  const { result } = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ lowConfidence: true }) } })
  assert.equal(result.substituted, false)
  assert.equal(result.code, 'model-self-doubt')
})

test('a verdict with no confidence and no probabilities cannot clear any gate', async () => {
  const { result } = await run({ prefer: 'model-first', deps: { consultModel: async () => ({ choice: 'Approve', risk: 'low' }) } })
  assert.equal(result.substituted, false)
  assert.equal(result.code, 'missing-confidence')
})

/* ─────────────────────────── unusable model answers ───────────────────────── */

test('an answer naming an option nobody offered is discarded', async () => {
  for (const choice of ['Maybe', 'approve', 'APPROVE', '']) {
    const { result } = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ choice }) } })
    assert.equal(result.substituted, false, JSON.stringify(choice))
    assert.equal(result.answer, null)
    assert.ok(['model-unknown-option', 'model-empty-choice'].includes(result.code), result.code)
  }
  // the label match is whitespace-tolerant (the choice is trimmed) but case-sensitive
  const padded = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ choice: '  Approve\n' }) } })
  assert.equal(padded.result.substituted, true)
})

test('out-of-range confidence or an unknown risk discards the answer', async () => {
  const badConf = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ confidence: 1.01 }) } })
  assert.equal(badConf.result.code, 'model-bad-confidence')
  const badRisk = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ risk: 'spicy' }) } })
  assert.equal(badRisk.result.code, 'model-bad-risk')
  const nan = await run({ prefer: 'model-first', deps: { consultModel: async () => answer({ confidence: Number.NaN }) } })
  assert.equal(nan.result.code, 'model-bad-confidence')
})

/* ────────────────────────── transport failure modes ───────────────────────── */

test('a throwing transport, a null, a string and an undefined answer all fail closed', async () => {
  const cases = [
    ['throws', async () => { throw new Error('HTTP 500') }, 'model-error'],
    ['null', async () => null, 'model-empty'],
    ['string', async () => 'not an object', 'model-malformed'],
    ['array', async () => ['Approve'], 'model-malformed'],
    ['undefined', async () => undefined, 'model-empty'],
  ]
  for (const [label, consultModel, code] of cases) {
    const { result } = await run({ prefer: 'model-first', deps: { consultModel } })
    assert.equal(result.source, 'none', label)
    assert.equal(result.substituted, false, label)
    assert.equal(result.answer, null, label)
    assert.equal(result.code, code, label)
    assert.equal(result.record.reason.length > 0, true, label)
  }
})

test('a transport that hangs past the model deadline times out and blocks', async () => {
  const { result } = await run({
    prefer: 'model-first',
    deps: {
      consultModel: () => new Promise(() => {}),
      // fire the deadline immediately: deterministic, no real sleep
      setTimer: (fn) => {
        fn()
        return 1
      },
      clearTimer: () => {},
    },
  })
  assert.equal(result.source, 'none')
  assert.equal(result.code, 'model-timeout')
  assert.equal(result.answer, null)
})

test('an aborted request fails closed before and during the model call', async () => {
  const controller = new AbortController()
  controller.abort()
  const pre = await run({ prefer: 'model-first', signal: controller.signal })
  assert.equal(pre.result.code, 'aborted')
  assert.equal(pre.result.substituted, false)

  const during = new AbortController()
  const { result } = await run({
    prefer: 'model-first',
    signal: during.signal,
    deps: {
      consultModel: async () => {
        during.abort()
        return answer()
      },
    },
  })
  assert.equal(result.source, 'none')
  assert.equal(result.code, 'aborted')
  assert.equal(result.answer, null)
})

test('no transport wired at all is fail-closed, not a silent pass', async () => {
  const result = await arbitrate({
    request: request(),
    decisionClass: 'artifact.tweak',
    deps: { record: () => {}, now: () => 1 },
    config: config(),
    prefer: 'model-first',
  })
  assert.equal(result.source, 'none')
  assert.equal(result.code, 'no-model-source')
  assert.equal(result.answer, null)
})

/* ───────────────────────── shape guards on the request ────────────────────── */

test('a question with no options, a batch, or multi-select never substitutes', async () => {
  const noOptions = await run({ prefer: 'model-first', request: { id: 'q', question: 'x' } })
  assert.equal(noOptions.result.code, 'no-options')
  assert.equal(noOptions.modelCalls, 0, 'nothing to ask the model about')
  const batch = await run({ prefer: 'model-first', questions: [request(), request()] })
  assert.equal(batch.result.code, 'batched-question')
  assert.equal(batch.result.substituted, false)
  const multi = await run({ prefer: 'model-first', request: request({ multiSelect: true }) })
  assert.equal(multi.result.code, 'multi-select')
  assert.equal(multi.result.substituted, false)
})

test('a zero veto window means substitution is not offered at all', async () => {
  const { result } = await run({ prefer: 'model-first', config: config({ vetoWindowMs: 0 }) })
  assert.equal(result.code, 'no-veto-window')
  assert.equal(result.substituted, false)
  assert.equal(result.answer, null)
})

test('an irreversible class is never substituted even if the options claim reversibility', async () => {
  const { result } = await run({
    prefer: 'model-first',
    decisionClass: 'test.baseline',
    complexity: 'trivial',
    request: request({ options: LABELS.map((label) => ({ label, reversible: true })) }),
  })
  assert.equal(result.mode, 'hold')
  assert.equal(result.substituted, false)
})

/* ─────────────────────────── low-confidence policy ────────────────────────── */

test('onLowConfidence: block/advisory/defer-model all keep the pipeline blocked', async () => {
  const low = async () => answer({ confidence: 0.3 })
  for (const policy of ['block', 'advisory', 'defer-model']) {
    const { result } = await run({ prefer: 'model-first', config: config({ onLowConfidence: policy }), deps: { consultModel: low } })
    assert.equal(result.substituted, false, policy)
    assert.equal(result.answer, null, policy)
    if (policy === 'block') assert.equal(result.source, 'none', policy)
    if (policy === 'advisory') {
      assert.equal(result.source, 'model')
      assert.equal(result.advisory, true)
      assert.equal(result.code, 'low-confidence-advisory')
    }
    if (policy === 'defer-model') assert.equal(result.advisory ?? false, true, 'the fallback opinion is an advisory only')
  }
})

test('defer-model asks the fallback transport but never lets it substitute', async () => {
  const { result, modelCalls } = await run({
    prefer: 'model-first',
    config: config({ onLowConfidence: 'defer-model' }),
    deps: {
      consultModel: async () => answer({ confidence: 0.3 }),
      consultModelFallback: async () => answer({ choice: 'Reject', confidence: 0.99 }),
    },
  })
  assert.equal(modelCalls, 1)
  assert.equal(result.substituted, false)
  assert.equal(result.answer, null)
  assert.equal(result.record.fallback_used, true)
  assert.equal(result.code, 'low-confidence-deferred')
})

/* ──────────────────────── option-order bias mitigation ────────────────────── */

test('a verdict inside the uncertain band is re-asked reversed and must agree', async () => {
  // generic.question carries no band floor: 0.65 sits inside [0.60, 0.70) for the
  // operator floor, which is what this test is about. artifact.tweak would floor
  // the bar at 0.85 and 0.65 would be a plain below-bar escalation instead.
  let call = 0
  const agree = await run({
    decisionClass: 'generic.question',
    prefer: 'model-first',
    config: config({ confidenceThreshold: 0.6 }),
    deps: {
      consultModel: async () => {
        call += 1
        return answer({ confidence: 0.65 })
      },
    },
  })
  assert.equal(call, 2, 'the band [bar, bar+0.1) triggers exactly one reversal retry')
  assert.equal(agree.result.substituted, true)
  assert.equal(agree.records[0].retry_reversed, true)
  assert.equal(agree.records[0].agreement, true)

  let call2 = 0
  const disagree = await run({
    decisionClass: 'generic.question',
    prefer: 'model-first',
    deps: {
      consultModel: async () => {
        call2 += 1
        return call2 === 1 ? answer({ confidence: 0.65 }) : answer({ choice: 'Reject', confidence: 0.65 })
      },
    },
  })
  assert.equal(disagree.result.substituted, false)
  assert.equal(disagree.result.code, 'option-order-disagreement')
  assert.equal(disagree.records[0].agreement, false)

  let call3 = 0
  const unusable = await run({
    decisionClass: 'generic.question',
    prefer: 'model-first',
    deps: {
      consultModel: async () => {
        call3 += 1
        if (call3 === 1) return answer({ confidence: 0.65 })
        throw new Error('second call failed')
      },
    },
  })
  assert.equal(unusable.result.substituted, false)
  assert.equal(unusable.result.code, 'option-order-disagreement')
})

test('a verdict well above the band is not re-asked', async () => {
  const { modelCalls, result } = await run({ decisionClass: 'generic.question', prefer: 'model-first', deps: { consultModel: async () => answer({ confidence: 0.95 }) } })
  assert.equal(modelCalls, 1)
  assert.equal(result.substituted, true)
  assert.equal(result.record.retry_reversed, false)
  assert.equal(result.record.agreement, null)
})

/* ───────────────────────── deterministic C0 resolver ──────────────────────── */

test('C0: a matching allow-rule answers without any model call', async () => {
  const { result, records, modelCalls } = await run({
    prefer: 'model-first',
    complexity: 'trivial',
    config: config({ classify: { deterministicTrivial: true, allowRules: [{ decisionClass: 'artifact.tweak', choose: 'Approve', contains: '' }] } }),
  })
  assert.equal(result.source, 'deterministic')
  assert.equal(result.substituted, true)
  assert.deepEqual(result.answer, shapedAnswer(request(), 'Approve'))
  assert.equal(modelCalls, 0, 'the model must not be consulted for a deterministic answer')
  assert.equal(records[0].model, 'allow-rule')
})

test('C0 near-miss: an allow-rule that names an unoffered option does not answer', async () => {
  const { result, records, modelCalls } = await run({
    prefer: 'model-first',
    complexity: 'trivial',
    config: config({ classify: { deterministicTrivial: true, allowRules: [{ decisionClass: 'artifact.tweak', choose: 'Nope', contains: '' }] } }),
  })
  assert.equal(result.source, 'model')
  assert.equal(modelCalls, 1)
  assert.equal(records[0].promoted_from_c0, true, 'a C0 resolver that hits an unknown promotes to C2, never silently stays trivial')
})

test('C0 is not offered without a veto window, and never on the Point-B lane', async () => {
  const noVeto = await run({
    prefer: 'model-first',
    complexity: 'trivial',
    config: config({ vetoWindowMs: 0, classify: { deterministicTrivial: true, allowRules: [{ decisionClass: 'artifact.tweak', choose: 'Approve' }] } }),
  })
  assert.equal(noVeto.result.source, 'model')
  assert.equal(noVeto.modelCalls, 1)
  const pointB = await run({
    prefer: 'timeout-fallback',
    humanTimedOut: true,
    complexity: 'trivial',
    config: config({ classify: { deterministicTrivial: true, allowRules: [{ decisionClass: 'artifact.tweak', choose: 'Approve' }] } }),
  })
  assert.equal(pointB.result.source, 'deterministic')
  assert.equal(pointB.result.answer, null, 'Point B never answers the call, not even deterministically')
  assert.equal(pointB.result.substituted, false)
})

/* ─────────────────────────────── audit record ─────────────────────────────── */

test('exactly one audit record per invocation, on every path', async () => {
  const scenarios = [
    { prefer: 'model-first' },
    { prefer: 'timeout-fallback', humanTimedOut: true },
    { prefer: 'model-first', deps: { consultModel: async () => { throw new Error('x') } } },
    { prefer: 'model-first', deps: { consultModel: async () => answer({ choice: 'Nope' }) } },
    { decisionClass: 'test.unlock', prefer: 'model-first' },
    { decisionClass: 'made.up', prefer: 'model-first' },
    { prefer: 'model-first', request: { id: 'q', question: 'no options' } },
    { prefer: 'model-first', config: config({ enabled: false }) },
    { prefer: 'model-first', complexity: 'trivial', config: config({ classify: { allowRules: [{ decisionClass: 'artifact.tweak', choose: 'Approve' }] } }) },
  ]
  for (const [i, scenario] of scenarios.entries()) {
    const { records } = await run(scenario)
    assert.equal(records.length, 1, `scenario ${i}`)
    assert.equal(typeof records[0].ts, 'string', `scenario ${i}`)
    assert.equal(typeof records[0].code, 'string', `scenario ${i}`)
    assert.equal(records[0].human_override, false, `scenario ${i}`)
    assert.equal(records[0].superseded_by, null, `scenario ${i}`)
  }
})

test('SAFETY: a substitution that cannot be audited is withdrawn', async () => {
  const { result } = await run({
    prefer: 'model-first',
    deps: {
      record: () => {
        throw new Error('disk full')
      },
    },
  })
  assert.equal(result.substituted, false)
  assert.equal(result.answer, null)
  assert.equal(result.source, 'none')
  assert.equal(result.code, 'audit-failed')
  assert.equal(result.record.would_have_substituted, true)
  assert.equal(result.record.audit_failed, true)
})

test('an advisory verdict survives a failing audit sink (it applies nothing)', async () => {
  const { result } = await run({
    prefer: 'model-first',
    config: config({ classes: { 'artifact.tweak': 'advisory' } }),
    deps: {
      record: () => {
        throw new Error('disk full')
      },
    },
  })
  assert.equal(result.advisory, true)
  assert.equal(result.substituted, false)
})

test('the audit record carries the fields the docs promise', async () => {
  const { result } = await run({ prefer: 'model-first' })
  const r = result.record
  for (const key of [
    'ts', 'question_id', 'question_text', 'class', 'options_in_order', 'mode', 'prefer', 'trigger',
    'source', 'substituted', 'applied', 'advisory', 'applicable', 'requires_post_hoc_review', 'timed_out',
    'chosen', 'confidence', 'p_max', 'p_max_over_second', 'confidence_from_pmax', 'gate_value', 'gate',
    'threshold', 'risk', 'model', 'state_digest', 'latency_ms', 'retry_reversed', 'agreement',
    'human_override', 'superseded_by', 'code', 'reason', 'reversible', 'veto_window_ms', 'veto_until',
    'escalate_after_ms', 'escalate_at',
  ]) {
    assert.ok(key in r, `record.${key} is missing`)
  }
  assert.equal(r.options_in_order.join(','), LABELS.join(','))
  assert.equal(r.class, 'artifact.tweak')
  assert.equal(r.threshold, 0.6)
  assert.equal(r.reversible, true)
})

test('escalate_at marks a decision that is still blocking after a timeout', async () => {
  const blocked = await run({ prefer: 'timeout-fallback', humanTimedOut: true, config: config({ onLowConfidence: 'block' }), deps: { consultModel: async () => answer({ confidence: 0.1 }) } })
  assert.equal(blocked.result.escalateAt, 1_000_000 + 3_600_000)
  assert.equal(blocked.result.applicable, false)
  const preempt = await run({ prefer: 'model-first' })
  assert.equal(preempt.result.escalateAt, null, 'no timeout, nothing to escalate')
  // NOTE: the Point-B *applicable* case is pinned in test/known-defects.test.js —
  // the code writes escalate_at there too, although nothing is left blocking.
})

/* ────────────────────────────── pure helpers ──────────────────────────────── */

test('probabilityStats: p_max, margin and the vendor confidence formula', () => {
  assert.deepEqual(probabilityStats({ confidence: 0.7, probabilities: null }).gateValue, 0.7)
  const two = probabilityStats({ confidence: null, probabilities: { A: 0.8, B: 0.2 } })
  assert.equal(two.pMax, 0.8)
  assert.equal(Math.round(two.pMaxOverSecond * 100) / 100, 0.6)
  assert.equal(Math.round(two.derivedConfidence * 100) / 100, 0.6)
  const single = probabilityStats({ confidence: null, probabilities: { A: 0.9 } })
  assert.equal(single.pMax, 0.9)
  assert.equal(single.derivedConfidence, null, 'a one-option Choice has no defined confidence')
})

test('validateModelAnswer is exported, pure and refuses everything unusable', () => {
  assert.equal(validateModelAnswer({ choice: 'Approve' }, LABELS).ok, true)
  assert.equal(validateModelAnswer({ choice: 'X' }, LABELS).code, 'model-unknown-option')
  assert.equal(validateModelAnswer(null, LABELS).code, 'model-empty')
  assert.equal(validateModelAnswer('Approve', LABELS).code, 'model-malformed')
  const kept = validateModelAnswer({ choice: 'Approve', probabilities: { Approve: 0.7, Evil: 0.9, Weird: 2 } }, LABELS)
  assert.deepEqual(kept.probabilities, { Approve: 0.7 })
  assert.equal(validateModelAnswer({ choice: 'Approve' }, LABELS).risk, 'unknown')
})

test('the outcome object is fail-closed by construction', async () => {
  // even a caller that passes nothing gets a blocking outcome and one record
  const result = await arbitrate()
  assert.equal(result.answer, null)
  assert.equal(result.substituted, false)
  assert.equal(result.source, 'none')
  assert.equal(result.record.code, 'no-options')
})
