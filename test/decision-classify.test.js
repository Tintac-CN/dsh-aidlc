/**
 * `lib/decision/classify.js` — the deterministic System-0 classifier.
 *
 * Contract: no model call, explainable (`reasons[]`), and every rule can only
 * make the answer LESS automated. Defaults to `complex` when it cannot tell.
 * The fail-closed promotions of design §7.3 / decision-model §3 are each pinned.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOptionsReversible, classify, isKnownClass, matchAllowRule, offeredLabels, questionText } from '../lib/decision/classify.js'
import { NEVER_AUTO } from '../lib/decision/policy.js'

const q = (extra = {}) => ({ question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }], ...extra })
const classifyOptions = { optionCount: 2 }

test('a tagged decision class is authoritative and lands on its class floor', () => {
  const r = classify(q({ intent: 'unit.ordering' }), {})
  assert.equal(r.decisionClass, 'unit.ordering')
  // task-15: every keyword-inferable class carries a C2 `minLevel`, so a tag can
  // no longer buy the C1 band the untagged path would not get. The declared class
  // is still authoritative; its band is now the class floor.
  assert.equal(r.complexity, 'simple')
  assert.equal(r.level, 'C2_SIMPLE')
  assert.equal(r.reasons.length > 0, true, 'the reasons that drove the answer are reported')
  assert.match(r.reasons.join(' '), /unit\.ordering/)
})

test('no class at all promotes to C3, and the two spellings agree (D2 invariant)', () => {
  const r = classify({ question: 'zzz nothing recognizable zzz', options: [{ label: 'A' }, { label: 'B' }] }, {})
  assert.equal(r.decisionClass, 'generic.question')
  assert.equal(r.level, 'C3_COMPLEX')
  assert.equal(r.complexity, 'complex', '`level` and `complexity` are two spellings of one answer — reconcileLevel enforces it at the single exit')
  assert.ok(r.promotions.some((p) => /no decision class/.test(p)))
})

test('a class assigned by a model can never lower its own gate', () => {
  const viaContext = classify(q({ intent: 'unit.ordering' }), { decisionClassFrom: 'model' })
  assert.equal(viaContext.level, 'C3_COMPLEX', 'class assignment is itself C3')
  const viaQuestion = classify(q({ intent: 'unit.ordering', classifiedBy: 'model' }), {})
  assert.equal(viaQuestion.level, 'C3_COMPLEX')
})

test('the never-auto classes are never trivial', () => {
  for (const id of NEVER_AUTO) {
    const r = classify(q({ intent: id }), {})
    assert.equal(r.decisionClass, id)
    assert.equal(r.complexity, 'complex', id)
    assert.equal(r.level, 'C3_COMPLEX', id)
  }
})

test('the documented fail-closed promotions', () => {
  assert.equal(classify(q({ intent: 'unit.ordering' }), { onGate: true }).level, 'C3_COMPLEX', 'a gate question is complex')
  assert.equal(classify(q({ intent: 'unit.ordering' }), { hiddenJudgments: 4 }).level, 'C3_COMPLEX', 'more than three hidden judgments')
  assert.equal(classify(q({ intent: 'unit.ordering' }), { hiddenJudgments: 3 }).level, 'C2_SIMPLE', 'three is still allowed — the class floor is C2 and three does not promote to C3')
  assert.equal(classify(q({ intent: 'unit.ordering' }), { externalText: true }).level, 'C3_COMPLEX', 'text authored outside the repo')
  assert.equal(classify(q({ intent: 'unit.ordering', externalText: true }), {}).level, 'C3_COMPLEX')
  assert.equal(classify(q({ intent: 'unit.ordering', multiSelect: true }), {}).level, 'C3_COMPLEX', 'multi-select')
  assert.equal(classify({ question: 'x', options: [] }, {}).level, 'C3_COMPLEX', 'no options')
  assert.equal(classify({ question: 'x', options: [] }, { decisionClass: 'unit.ordering' }).level, 'C3_COMPLEX', 'no options is complex even for a tagged class')
})

test('shape signals only ever move in the conservative direction', () => {
  // task-15: the baseline for a keyword-inferable class is its C2 floor, so the
  // "clean" shape already sits at simple; every other signal can only raise it.
  assert.equal(classify(q({ intent: 'unit.ordering' }), {}).complexity, 'simple')
  assert.equal(classify({ ...q({ intent: 'unit.ordering' }), options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }, {}).complexity, 'simple')
  assert.equal(classify({ ...q({ intent: 'unit.ordering' }), options: 'x' }, {}).complexity, 'complex')
  const many = classify({ ...q({ intent: 'unit.ordering' }), options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label })) }, {})
  assert.equal(many.complexity, 'complex')
  const risky = classify(q({ intent: 'unit.ordering', question: 'Delete the production database?' }), {})
  assert.equal(risky.complexity, 'complex', 'risky wording')
  const long = classify(q({ intent: 'unit.ordering', question: 'x'.repeat(900) }), {})
  assert.equal(long.complexity, 'complex', 'long text')
  const medium = classify(q({ intent: 'unit.ordering', question: 'x'.repeat(300) }), {})
  assert.equal(medium.complexity, 'simple')
  const paths = classify(q({ intent: 'unit.ordering' }), { affectedPaths: ['a'] })
  assert.equal(paths.complexity, 'simple')
  const manyPaths = classify(q({ intent: 'unit.ordering' }), { affectedPaths: ['a', 'b', 'c'] })
  assert.equal(manyPaths.complexity, 'complex')
})

test('an explicit decisionClass is authoritative; an unknown tag is ignored, not guessed', () => {
  const r = classify(q(), { decisionClass: 'artifact.tweak' })
  assert.equal(r.decisionClass, 'artifact.tweak')
  const unknown = classify(q({ intent: 'made.up' }), {})
  assert.notEqual(unknown.decisionClass, 'made.up')
  assert.match(unknown.reasons.join(' '), /ignored unknown intent tag/)
  const unknownExplicit = classify(q({ intent: 'unit.ordering' }), { decisionClass: 'made.up' })
  assert.equal(unknownExplicit.decisionClass, 'unit.ordering', 'a bad explicit class falls through to the intent tag')
})

test('aliases point only at narrower/safer classes', () => {
  assert.equal(classify(q({ intent: 'plan-review' }), {}).decisionClass, 'gate.approval', 'a plan review is a human gate')
  assert.equal(classify({ question: 'x', options: [], intent: { kind: 'plan-review' } }, {}).decisionClass, 'gate.approval')
  assert.equal(classify(q({ intent: 'unlock' }), {}).decisionClass, 'test.unlock')
  assert.equal(classify(q({ intent: 'typo' }), {}).decisionClass, 'artifact.tweak')
  assert.equal(classify(q({ intent: 'architecture' }), {}).decisionClass, 'design.choice')
})

test('wording inference prefers the never-auto classes', () => {
  assert.equal(classify({ question: 'Should we accept the new baseline?', options: [{ label: 'A' }, { label: 'B' }] }, {}).decisionClass, 'test.baseline')
  assert.equal(classify({ question: 'Please approve the plan', options: [{ label: 'A' }, { label: 'B' }] }, {}).decisionClass, 'gate.approval')
  assert.equal(classify({ question: 'Can I have the API key for staging?', options: [{ label: 'A' }, { label: 'B' }] }, {}).decisionClass, 'security.exception')
  assert.equal(classify({ question: 'Should we deploy to production?', options: [{ label: 'A' }, { label: 'B' }] }, {}).decisionClass, 'irreversible.operation')
  assert.equal(classify({ question: 'Unlock the TDD lock now?', options: [{ label: 'A' }, { label: 'B' }] }, {}).decisionClass, 'test.unlock')
  assert.equal(classify({ question: 'A typo in the README', options: [{ label: 'A' }, { label: 'B' }] }, {}).decisionClass, 'artifact.tweak')
})

test('the classifier reports the reasons and the C0 resolver it found', () => {
  const rules = [{ decisionClass: 'unit.ordering', choose: 'A', contains: '' }]
  const r = classify(q({ intent: 'unit.ordering' }), { config: { classify: { allowRules: rules } } })
  assert.equal(r.level, 'C0_COMPUTED')
  assert.deepEqual(r.c0, { resolver: 'allow-rule', rule: rules[0] })
  assert.equal(classify(q({ intent: 'unit.ordering' }), { config: { classify: { allowRules: rules, deterministicTrivial: false } } }).level, 'C2_SIMPLE', 'switching the resolver off is treated like a miss: the conservative direction')
  assert.equal(typeof r.confidence, 'number')
  assert.ok(r.confidence >= 0 && r.confidence <= 1)
})

test('the C0 resolver that misses promotes to C2, never silently stays C1', () => {
  const r = classify(q({ intent: 'unit.ordering' }), { config: { classify: { allowRules: [{ decisionClass: 'unit.ordering', choose: 'NotOffered' }] } } })
  assert.equal(r.level, 'C2_SIMPLE')
  assert.ok(r.promotions.some((p) => /deterministic resolver/.test(p)))
})

test('allOptionsReversible is fail-closed on unknown shapes', () => {
  assert.equal(allOptionsReversible({ options: [{ label: 'A' }] }, 'artifact.tweak'), true)
  // gate.approval is reversible now (an armed gate verdict is undone by the veto
  // window); the irreversible classes are the authority ones
  assert.equal(allOptionsReversible({ options: [{ label: 'A' }] }, 'gate.approval'), true)
  assert.equal(allOptionsReversible({ options: [{ label: 'A' }] }, 'test.unlock'), false, 'an irreversible authority class is not reversible')
  assert.equal(allOptionsReversible({ options: [{ label: 'A' }] }, 'made.up'), false, 'an unknown class is treated as irreversible')
  assert.equal(allOptionsReversible({ options: [] }, 'artifact.tweak'), false)
  assert.equal(allOptionsReversible({ options: [{ label: 'A', reversible: false }] }, 'artifact.tweak'), false)
  // D8 CLOSED, and strengthened: request-declared `reversible:true` can never
  // upgrade the answer — the class decides, and the caller's veto outranks it.
  assert.equal(allOptionsReversible({ options: [{ label: 'A', reversible: true }, { label: 'B', reversible: true }] }, 'test.unlock'), false, 'an irreversible class is never upgraded by request data')
  assert.equal(allOptionsReversible({ options: [{ label: 'A', reversible: true }, { label: 'B', reversible: true }] }, 'artifact.tweak'), true, 'a reversible class stays reversible')
  assert.equal(allOptionsReversible({ options: [{ label: 'A', reversible: true }, { label: 'B' }] }, 'artifact.tweak'), true)
  assert.equal(allOptionsReversible({ options: [{ label: 'A', reversible: true }] }, 'artifact.tweak', { allOptionsReversible: false }), false, 'the caller’s veto wins over request data')
  assert.equal(allOptionsReversible({ options: [{ label: 'A' }] }, 'artifact.tweak', { allOptionsReversible: false }), false)
})

test('offeredLabels / questionText only read strings, in order', () => {
  assert.deepEqual(offeredLabels({ options: [{ label: 'B' }, { label: 'A' }, { label: '  ' }, {}, null] }), ['B', 'A'])
  assert.deepEqual(offeredLabels({}), [])
  assert.equal(questionText({ header: 'H', question: 'Q', detail: 'D' }), 'H\nQ\nD')
  assert.equal(questionText({ header: 'H', detail: '   ' }), 'H')
  assert.equal(matchAllowRule([{ decisionClass: 'artifact.tweak', choose: 'A' }], { decisionClass: 'artifact.tweak', labels: ['A'] }).choose, 'A')
  assert.equal(matchAllowRule([{ decisionClass: 'artifact.tweak', choose: 'A' }], { decisionClass: 'made.up', labels: ['A'] }), null)
  assert.equal(isKnownClass('artifact.tweak'), true)
  assert.equal(isKnownClass('nope'), false)
})
