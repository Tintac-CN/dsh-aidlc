/**
 * `lib/decision/policy.js` (+ the `lib/config.js` validator) — the AUTHORITY
 * clamp, the triage mode resolution, the complexity ladder and the config
 * normalisation.
 *
 * The property under attack: the six authority classes cannot be configured into
 * triage by any config shape, including hand-built objects that never went
 * through the validator. (`gate.approval` is deliberately NOT an authority class
 * any more: it defaults to advisory and is armable with a warning.)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DECISION_CLASSES,
  DECISION_CLASS_IDS,
  DECISION_LEVELS,
  DECISION_MODES,
  LEVEL_FLOOR,
  MODE_ALIASES,
  NEVER_AUTO,
  armingWarning,
  canonicalMode,
  classDefinition,
  describeMode,
  gateForLevel,
  isKnownMode,
  isNeverAuto,
  isReversible,
  isSubstitutable,
  matchAllowRuleRules,
  normalizeDecisionConfig,
  resolveMode,
} from '../lib/decision/policy.js'
import { Config, validateConfig } from '../lib/config.js'

const hostile = (mode = 'triage') => ({ classes: Object.fromEntries(DECISION_CLASS_IDS.map((id) => [id, mode])) })

test('the authority set is the six documented classes; gate.approval is not one', () => {
  assert.deepEqual([...NEVER_AUTO].sort(), [
    'irreversible.operation',
    'policy.change',
    'security.exception',
    'test.baseline',
    'test.unlock',
    'untrusted.authorization',
  ])
  assert.equal(NEVER_AUTO.has('gate.approval'), false)
  for (const id of NEVER_AUTO) assert.equal(isNeverAuto(id), true, id)
  assert.equal(isNeverAuto('artifact.tweak'), false)
  assert.equal(isNeverAuto('gate.approval'), false)
  assert.equal(isNeverAuto('nope'), false)
})

test('SAFETY: no configuration can arm an authority class for triage', () => {
  for (const id of NEVER_AUTO) {
    for (const mode of ['triage', 'substitute', 'advisory', 'hold']) {
      const resolved = resolveMode({ decisionClass: id, config: hostile(mode) })
      assert.notEqual(resolved, 'triage', `${id} armed as ${mode}`)
      assert.ok(DECISION_MODES.includes(resolved))
      assert.equal(isSubstitutable(id, hostile(mode)), false, id)
      // and the plain object literal, without the validator
      assert.notEqual(resolveMode({ decisionClass: id, config: { classes: { [id]: mode } } }), 'triage')
      // and through a schemastery wrapper shape
      assert.notEqual(resolveMode({ decisionClass: id, config: { get: () => ({ classes: { [id]: mode } }) } }), 'triage')
    }
    assert.equal(resolveMode({ decisionClass: id, config: hostile('triage') }), 'hold', `${id} defaults to hold`)
  }
  // gate.approval is the exception by design: armable, and the warning says what that means
  assert.equal(resolveMode({ decisionClass: 'gate.approval', config: hostile('triage') }), 'triage')
})

test('resolveMode: triage defaults, the alias, unknowns, the disable switch and an explicit hold', () => {
  for (const id of DECISION_CLASS_IDS) {
    const expected = canonicalMode(DECISION_CLASSES[id].defaultMode) ?? 'hold'
    assert.equal(resolveMode({ decisionClass: id, config: {} }), expected, id)
  }
  const judgment = ['gate.reject-feedback', 'design.choice', 'scope.expansion', 'plan.confirmation', 'unit.ordering', 'artifact.tweak', 'generic.question']
  for (const id of judgment) assert.equal(resolveMode({ decisionClass: id, config: {} }), 'triage', id)
  assert.equal(resolveMode({ decisionClass: 'gate.approval', config: {} }), 'advisory')
  assert.equal(resolveMode({ decisionClass: 'unknown.class', config: hostile() }), 'hold', 'an unknown class is never trusted')
  assert.equal(resolveMode({ decisionClass: undefined, config: {} }), 'hold')
  assert.equal(resolveMode({}), 'hold')
  assert.equal(resolveMode(), 'hold')
  assert.equal(resolveMode({ decisionClass: 'artifact.tweak', config: { enabled: false } }), 'hold', 'the master switch means "as before this plugin existed"')
  assert.equal(resolveMode({ decisionClass: 'artifact.tweak', config: { classes: { 'artifact.tweak': 'hold' } } }), 'hold')
  assert.equal(resolveMode({ decisionClass: 'artifact.tweak', config: { classes: { 'artifact.tweak': 'advisory' } } }), 'advisory')
  assert.equal(resolveMode({ decisionClass: 'artifact.tweak', config: { classes: { 'artifact.tweak': 'substitute' } } }), 'triage', 'the alias canonicalises')
  assert.equal(resolveMode({ decisionClass: 'artifact.tweak', config: { classes: { 'artifact.tweak': 'nonsense' } } }), 'triage', 'an unusable value falls back to the class default')
  assert.equal(describeMode('unit.ordering', {}), 'unit.ordering -> triage')
  assert.equal(classDefinition('artifact.tweak').reversible, true)
  assert.equal(classDefinition('nope'), null)
  // the alias and the canonical spelling are one behaviour
  assert.equal(canonicalMode('substitute'), 'triage')
  assert.equal(canonicalMode('triage'), 'triage')
  assert.equal(canonicalMode('nonsense'), null)
  assert.equal(isKnownMode('substitute'), true)
  assert.equal(isKnownMode('nonsense'), false)
  assert.deepEqual({ ...MODE_ALIASES }, { substitute: 'triage' })
})

test('every irreversible class is an authority class (the apply-block invariant)', () => {
  // the arbiter lets a deterministic allow-rule answer before consulting
  // `applyBlock`, so a reversible=false class reachable through triage would be a
  // hole. This pins the taxonomy property that makes it unreachable.
  for (const id of DECISION_CLASS_IDS) {
    if (isReversible(id) === false) assert.equal(isNeverAuto(id), true, `${id} is irreversible and must be an authority class`)
  }
  assert.equal(isReversible('gate.approval'), true, 'an armed gate verdict is reversible inside the veto window')
})

test('the ladder: complexity raises the bar (0.60 / 0.85 / 0.95)', () => {
  assert.equal(gateForLevel('C1_TRIVIAL', 0.6), 0.6)
  assert.equal(gateForLevel('C2_SIMPLE', 0.6), 0.85)
  assert.equal(gateForLevel('C3_COMPLEX', 0.6), 0.95)
  assert.equal(gateForLevel('C2_SIMPLE', 0.9), 0.9, 'the operator floor outranks a lower band bar')
  assert.equal(gateForLevel('C3_COMPLEX', 0.9), 0.95, 'the C3 bar outranks a lower operator floor')
  assert.equal(gateForLevel(null, 0.75), 0.75, 'an unclassified decision uses the operator floor')
  assert.equal(gateForLevel('nonsense', 0.7), 0.7)
  assert.deepEqual({ ...LEVEL_FLOOR }, { C0_COMPUTED: 0.6, C1_TRIVIAL: 0.6, C2_SIMPLE: 0.85, C3_COMPLEX: 0.95 })
  assert.deepEqual([...DECISION_LEVELS], ['C0_COMPUTED', 'C1_TRIVIAL', 'C2_SIMPLE', 'C3_COMPLEX'])
  // the calibratable override can only tighten, never loosen past the built-in bar
  assert.equal(gateForLevel('C3_COMPLEX', 0.6, { C3_COMPLEX: 0.97 }), 0.97)
  assert.equal(gateForLevel('C3_COMPLEX', 0.6, { C3_COMPLEX: 0.1 }), 0.6, 'a raw (un-normalised) lower value cannot go under the operator floor')
})

test('normalizeDecisionConfig never widens a bound', () => {
  const defaults = normalizeDecisionConfig(undefined)
  assert.equal(defaults.confidenceThreshold, 0.6)
  assert.equal(defaults.blockOnCriticalRisk, true)
  assert.equal(defaults.onLowConfidence, 'block')
  assert.equal(defaults.vetoWindowMs, 600_000)
  assert.equal(defaults.enabled, true)
  assert.deepEqual(defaults.levelFloors, {})
  // a lax threshold is clamped UP into range
  assert.equal(normalizeDecisionConfig({ confidenceThreshold: 0.01 }).confidenceThreshold, 0.5)
  assert.equal(normalizeDecisionConfig({ confidenceThreshold: 4 }).confidenceThreshold, 1)
  assert.equal(normalizeDecisionConfig({ confidenceThreshold: 'x' }).confidenceThreshold, 0.6)
  // unusable switches fall to the safe side
  assert.equal(normalizeDecisionConfig({ onLowConfidence: 'allow' }).onLowConfidence, 'block')
  assert.equal(normalizeDecisionConfig({ blockOnCriticalRisk: 'yes' }).blockOnCriticalRisk, true)
  assert.equal(normalizeDecisionConfig({ blockOnCriticalRisk: false }).blockOnCriticalRisk, false)
  assert.equal(normalizeDecisionConfig({ vetoWindowMs: -5 }).vetoWindowMs, 0)
  assert.equal(normalizeDecisionConfig({ enabled: false }).enabled, false)
  // the whole plugin config shape is accepted as well as the bare decision block
  assert.equal(normalizeDecisionConfig({ decision: { confidenceThreshold: 0.8 } }).confidenceThreshold, 0.8)
  // schemastery `.get()` wrappers are unwrapped
  assert.equal(normalizeDecisionConfig({ get: () => ({ decision: { confidenceThreshold: 0.7 } }) }).confidenceThreshold, 0.7)
  // allowRules keep only object entries
  assert.equal(normalizeDecisionConfig({ classify: { allowRules: [null, 'x', { decisionClass: 'a' }] } }).classify.allowRules.length, 1)
  // unknown class keys are ignored rather than honoured
  assert.equal(normalizeDecisionConfig({ classes: { 'made.up': 'triage' } }).classes['made.up'], undefined)
  // the mode is canonicalised inside the layer as well
  assert.equal(normalizeDecisionConfig({ classes: { 'artifact.tweak': 'substitute' } }).classes['artifact.tweak'], 'triage')
})

test('normalizeDecisionConfig: a typo or an out-of-range level floor cannot lower a bar', () => {
  for (const hostileFloors of [
    { C3_COMPLEX: 0.1 },
    { C3_COMPLEX: '0.9x' },
    { C3_COMPLEX: 2 },
    { C3_COMPLEX: -1 },
    { C3_COMPLEX: undefined },
    { C3_COMPLEX: {} },
    { C3_COMPLEX: [] },
    { C3_COMPLEX: true },
    'nonsense',
    null,
  ]) {
    assert.deepEqual(normalizeDecisionConfig({ levelFloors: hostileFloors }).levelFloors, {}, JSON.stringify(hostileFloors))
  }
  assert.deepEqual(normalizeDecisionConfig({ levelFloors: { C3_COMPLEX: 0.97 } }).levelFloors, { C3_COMPLEX: 0.97 })
  assert.deepEqual(normalizeDecisionConfig({ levelFloors: { ['made.up']: 0.1 } }).levelFloors, {}, 'unknown level keys are dropped')
})

test('matchAllowRuleRules is deliberately inexpressive', () => {
  const rules = [{ decisionClass: 'artifact.tweak', choose: 'Approve', contains: 'typo' }]
  const q = { question: 'fix the typo in the README', options: [{ label: 'Approve' }, { label: 'Reject' }] }
  assert.equal(matchAllowRuleRules(rules, { decisionClass: 'artifact.tweak', question: q, labels: ['Approve', 'Reject'] })?.choose, 'Approve')
  assert.equal(matchAllowRuleRules(rules, { decisionClass: 'artifact.tweak', question: q, labels: ['Approve'] })?.choose, 'Approve')
  // every miss is the cheap direction
  assert.equal(matchAllowRuleRules(rules, { decisionClass: 'design.choice', question: q, labels: ['Approve'] }), null, 'class must match exactly')
  assert.equal(matchAllowRuleRules(rules, { decisionClass: '', question: q, labels: ['Approve'] }), null, 'an empty class is never a wildcard')
  assert.equal(matchAllowRuleRules(rules, { decisionClass: 'artifact.tweak', question: q, labels: ['Nope'] }), null, 'choose must be offered')
  assert.equal(matchAllowRuleRules(rules, { decisionClass: 'artifact.tweak', question: { question: 'other' }, labels: ['Approve'] }), null, 'contains must be present')
  assert.equal(matchAllowRuleRules([{ decisionClass: 'made.up', choose: 'Approve' }], { decisionClass: 'made.up', question: q, labels: ['Approve'] }), null, 'an unknown class can never be matched')
  assert.equal(matchAllowRuleRules([{ decisionClass: 'artifact.tweak', choose: '' }], { decisionClass: 'artifact.tweak', question: q, labels: ['Approve'] }), null)
  assert.equal(matchAllowRuleRules([], { decisionClass: 'artifact.tweak', question: q, labels: ['Approve'] }), null)
  assert.equal(matchAllowRuleRules(null, {}), null)
})

test('validateConfig refuses triage/substitute for the six authority classes only', () => {
  const base = new Config({})
  assert.equal(validateConfig(base), null, 'the schema defaults are valid')
  for (const id of NEVER_AUTO) {
    for (const mode of ['triage', 'substitute']) {
      const cfg = { ...base, decision: { ...base.decision, classes: { ...base.decision.classes, [id]: mode } } }
      const error = validateConfig(cfg)
      assert.ok(typeof error === 'string' && error.includes(id), `${id}=${mode} must be refused, got ${error}`)
      assert.match(error, /never be auto-decided/)
    }
  }
  // gate.approval is armable (the warning is advisory, not a refusal)
  assert.equal(validateConfig({ ...base, decision: { ...base.decision, classes: { ...base.decision.classes, 'gate.approval': 'triage' } } }), null)
  // a substitutable judgment class is fine in either spelling
  assert.equal(validateConfig({ ...base, decision: { ...base.decision, classes: { ...base.decision.classes, 'unit.ordering': 'triage' } } }), null)
  assert.equal(validateConfig({ ...base, decision: { ...base.decision, classes: { ...base.decision.classes, 'unit.ordering': 'substitute' } } }), null)
  // an unknown key, an out-of-range threshold, a bad switch
  assert.match(validateConfig({ ...base, decision: { ...base.decision, classes: { 'made.up': 'hold' } } }), /unknown decision class/)
  assert.match(validateConfig({ ...base, decision: { ...base.decision, confidenceThreshold: 0.2 } }), /confidenceThreshold/)
  assert.match(validateConfig({ ...base, decision: { ...base.decision, timeoutMs: -1 } }), /timeoutMs/)
  assert.match(validateConfig(null), /must be an object/)
  assert.match(validateConfig({}), /decision must be an object/)
  // an out-of-range level floor is refused by the schema, so the wiring falls back to the defaults
  assert.throws(() => new Config({ decision: { levelFloors: { C3_COMPLEX: 0.1 } } }))
  assert.throws(() => new Config({ decision: { levelFloors: { C2_SIMPLE: 2 } } }))
})

test('validateConfig requires a key for a non-loopback endpoint and allows loopback', () => {
  const base = new Config({})
  const withModel = (model) => ({ ...base, decision: { ...base.decision, model: { ...base.decision.model, ...model } } })
  assert.match(validateConfig(withModel({ protocol: 'systemone', baseURL: 'https://api.example.com/v1' })), /needs an API key/)
  assert.equal(validateConfig(withModel({ protocol: 'systemone', baseURL: 'http://127.0.0.1:8080/v1' })), null)
  assert.equal(validateConfig(withModel({ protocol: 'chat', baseURL: 'http://localhost:1234/v1' })), null)
  assert.equal(validateConfig(withModel({ protocol: 'chat', baseURL: 'https://api.example.com/v1', apiKey: 'sk-x' })), null)
  assert.match(
    validateConfig(withModel({ protocol: 'chat', baseURL: 'http://127.0.0.1@evil.example/v1' })),
    /needs an API key/,
    'credentials in the authority must not disguise a remote host as loopback',
  )
  // defer-model needs a second transport to defer to
  assert.match(validateConfig({ ...base, decision: { ...base.decision, onLowConfidence: 'defer-model' } }), /defer-model/)
  // the arming warning text lives in policy.js and is non-null only for an armed gate
  assert.equal(typeof armingWarning('gate.approval', 'triage'), 'string')
  assert.equal(armingWarning('gate.approval', 'advisory'), null)
})
