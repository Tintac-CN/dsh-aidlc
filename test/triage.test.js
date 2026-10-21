/**
 * The TRIAGE design (the user's correction) — the new behaviour, re-derived
 * from the design rather than from the code, and attacked.
 *
 * The model is now a triage layer: consulted FIRST for judgment classes, and the
 * human is asked only when the verdict fails to clear the confidence bar for the
 * decision's risk band (C0/C1 0.60 · C2 0.85 · C3 0.95). Complexity raises the
 * bar; it no longer forbids automation.
 *
 * What has NOT moved, and is re-attacked here:
 *   - the SIX authority classes are clamped at any confidence, in both lanes;
 *   - `AUTO-APPROVED` can never be a `GATE-APPROVED` receipt (now load-bearing:
 *     `gate.approval` is armable, so an AUTO receipt for a gate can legitimately
 *     exist — and must still be inert for gating).
 *
 * `DEFECT`-prefixed tests at the end are expected RED (open findings).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DECISION_CLASS_IDS,
  DECISION_MODES,
  LEVEL_FLOOR,
  MODE_ALIASES,
  NEVER_AUTO,
  armingWarning,
  canonicalMode,
  gateForLevel,
  isKnownMode,
  isSubstitutable,
  normalizeDecisionConfig,
  resolveMode,
} from '../lib/decision/policy.js'
import { classify } from '../lib/decision/classify.js'
import { arbitrate } from '../lib/decision/arbiter.js'
import { gateReceiptStatus, readLedger } from '../lib/aidlc/ledger.js'
import * as stateApi from '../lib/aidlc/state.js'
import * as ledgerApi from '../lib/aidlc/ledger.js'
import { Config, configWarnings, validateConfig } from '../lib/config.js'
import { AUTHORITY_CLASSES_FALLBACK, authoritySet, bandThresholds, bandThresholdLines, modeRows, registerTools } from '../lib/surface/tools.js'
import { intent, tmpRoot, write } from './helpers.mjs'

const request = (extra = {}) => ({ id: 'q1', question: 'Proceed with the tweak?', options: [{ label: 'Approve' }, { label: 'Reject' }], ...extra })
const triageConfig = (extra = {}) => ({ classes: { 'artifact.tweak': 'triage' }, ...extra })

/** Run one triage decision; count model calls and capture the audit record. */
async function triage({ confidence = 0.99, risk = 'low', prefer = 'model-first', complexity, level, config = triageConfig(), decisionClass = 'artifact.tweak', humanTimedOut } = {}) {
  let modelCalls = 0
  let record = null
  const outcome = await arbitrate({
    request: request(),
    decisionClass,
    ...(complexity ? { complexity } : {}),
    ...(level ? { level } : {}),
    ...(humanTimedOut === undefined ? {} : { humanTimedOut }),
    deps: {
      askHuman: () => {
        throw new Error('askHuman must never be called: the arbiter has no human race')
      },
      consultModel: async () => {
        modelCalls += 1
        return { choice: 'Approve', confidence, risk, reason: 'close call' }
      },
      record: (entry) => {
        record = entry
      },
      now: () => 1000,
    },
    config,
    prefer,
  })
  return { outcome, modelCalls, record }
}

/* ─────────────────────────── the six authority classes ────────────────────── */

test('the authority set is the six documented classes, and gate.approval is not one', () => {
  assert.equal(NEVER_AUTO.size, 6)
  assert.deepEqual([...NEVER_AUTO].sort(), [
    'irreversible.operation',
    'policy.change',
    'security.exception',
    'test.baseline',
    'test.unlock',
    'untrusted.authorization',
  ])
  assert.equal(NEVER_AUTO.has('gate.approval'), false, 'gate.approval is armable by design now')
  assert.deepEqual(AUTHORITY_CLASSES_FALLBACK.slice().sort(), [...NEVER_AUTO].sort(), 'the surface fallback must not drift from policy')
  assert.equal(authoritySet({}).has('gate.approval'), false)
})

test('SAFETY: no configuration arms an authority class for triage (the invariant that replaced the C3 refusal)', async () => {
  const hostile = { classes: Object.fromEntries(DECISION_CLASS_IDS.map((id) => [id, 'triage'])) }
  for (const decisionClass of NEVER_AUTO) {
    // the resolver clamp
    assert.equal(resolveMode({ decisionClass, config: hostile }), 'hold', decisionClass)
    assert.equal(isSubstitutable(decisionClass, hostile), false, decisionClass)
    // and the runtime clamp, at confidence 1.0, in every lane
    for (const prefer of ['model-first', 'timeout-fallback', undefined]) {
      const { outcome, modelCalls } = await triage({ decisionClass, prefer, confidence: 1, config: hostile })
      assert.equal(outcome.mode, 'hold', `${decisionClass}/${prefer}`)
      assert.equal(outcome.code, 'hold', `${decisionClass}/${prefer}`)
      assert.equal(outcome.answer, null, `${decisionClass}/${prefer}`)
      assert.equal(outcome.substituted, false, `${decisionClass}/${prefer}`)
      assert.equal(outcome.applicable, false, `${decisionClass}/${prefer}`)
      assert.equal(modelCalls, 0, `${decisionClass}/${prefer}: the model must not even be consulted`)
    }
  }
})

test('gate.approval is armable — with a warning — and the warning names the consequence', () => {
  assert.equal(resolveMode({ decisionClass: 'gate.approval', config: {} }), 'advisory', 'the default is still: model recommends, human decides')
  const armed = { classes: { 'gate.approval': 'triage' } }
  assert.equal(resolveMode({ decisionClass: 'gate.approval', config: armed }), 'triage')
  const warning = armingWarning('gate.approval', 'triage')
  assert.equal(typeof warning, 'string')
  assert.match(warning, /gate/)
  assert.match(warning, /AUTO-APPROVED/)
  assert.match(warning, /veto window/)
  assert.equal(armingWarning('gate.approval', 'advisory'), null, 'no warning when it is not armed')
  assert.equal(armingWarning('artifact.tweak', 'triage'), null, 'judgment classes need no warning')
  assert.equal(validateConfig({ ...new Config({}), decision: { ...new Config({}).decision, classes: { 'gate.approval': 'triage' } } }), null, 'the validator permits it (it is a deliberate opt-in, not an error)')
})

/* ────────────────────────────── modes and aliases ─────────────────────────── */

test('triage is the canonical mode; substitute is an alias that is never returned', () => {
  assert.deepEqual([...DECISION_MODES], ['hold', 'advisory', 'triage'])
  assert.deepEqual({ ...MODE_ALIASES }, { substitute: 'triage' })
  assert.equal(canonicalMode('substitute'), 'triage')
  assert.equal(canonicalMode('triage'), 'triage')
  assert.equal(canonicalMode('hold'), 'hold')
  assert.equal(canonicalMode('advisory'), 'advisory')
  assert.equal(canonicalMode('nonsense'), null)
  assert.equal(isKnownMode('substitute'), true)
  assert.equal(isKnownMode('nonsense'), false)
  for (const id of DECISION_CLASS_IDS) {
    for (const mode of ['hold', 'advisory', 'triage', 'substitute', 'nonsense']) {
      const resolved = resolveMode({ decisionClass: id, config: { classes: { [id]: mode } } })
      assert.notEqual(resolved, 'substitute', `${id}/${mode}`)
      assert.ok(DECISION_MODES.includes(resolved), `${id}/${mode}`)
    }
  }
})

test('default modes: judgment classes triage, gate.approval advisory, authority classes hold', () => {
  const judgment = ['gate.reject-feedback', 'design.choice', 'scope.expansion', 'plan.confirmation', 'unit.ordering', 'artifact.tweak', 'generic.question']
  for (const id of judgment) assert.equal(resolveMode({ decisionClass: id, config: {} }), 'triage', id)
  assert.equal(resolveMode({ decisionClass: 'gate.approval', config: {} }), 'advisory')
  for (const id of NEVER_AUTO) assert.equal(resolveMode({ decisionClass: id, config: {} }), 'hold', id)
  assert.equal(resolveMode({ decisionClass: 'made.up', config: {} }), 'hold', 'an unknown class is never trusted')
  assert.equal(resolveMode({ decisionClass: 'artifact.tweak', config: { enabled: false } }), 'hold', 'the master switch means "as before this plugin existed"')
})

/* ─────────────────────────────── the ladder ───────────────────────────────── */

test('the ladder: complexity raises the bar (0.60 / 0.85 / 0.95)', () => {
  assert.deepEqual({ ...LEVEL_FLOOR }, { C0_COMPUTED: 0.6, C1_TRIVIAL: 0.6, C2_SIMPLE: 0.85, C3_COMPLEX: 0.95 })
  assert.equal(gateForLevel('C1_TRIVIAL', 0.6), 0.6)
  assert.equal(gateForLevel('C2_SIMPLE', 0.6), 0.85)
  assert.equal(gateForLevel('C3_COMPLEX', 0.6), 0.95)
  assert.equal(gateForLevel(null, 0.6), 0.6, 'unclassified uses the operator floor')
  assert.equal(gateForLevel('C3_COMPLEX', 0.9), 0.95, 'the operator floor is a floor under the band bar')
  assert.equal(gateForLevel('C3_COMPLEX', 0.97), 0.97, 'and a higher operator floor wins')
})

test('a verdict at or above the band bar is applied; just below it escalates carrying the recommendation', async () => {
  for (const [label, complexity, bar, below, at, above, decisionClass] of [
    // The C1 row needs a class with no band floor: every keyword-inferable class
    // (including artifact.tweak, the helper's default) is floored at C2 (task-15).
    ['C1', 'trivial', 0.6, 0.59, 0.6, 0.61, 'generic.question'],
    ['C2', 'simple', 0.85, 0.84, 0.85, 0.86, 'artifact.tweak'],
    ['C3', 'complex', 0.95, 0.94, 0.95, 0.96, 'artifact.tweak'],
  ]) {
    const low = await triage({ decisionClass, complexity, confidence: below })
    assert.equal(low.outcome.substituted, false, `${label} below`)
    assert.equal(low.outcome.answer, null, `${label} below`)
    assert.equal(low.record.gate, bar, `${label} record.gate`)
    assert.equal(low.record.recommendation?.choice, 'Approve', `${label} below: the recommendation must be carried`)
    assert.equal(low.record.recommendation?.p_max !== undefined, true, `${label} below: p_max recorded`)

    const exact = await triage({ decisionClass, complexity, confidence: at })
    assert.equal(exact.outcome.substituted, true, `${label} at the bar (>= is a pass)`)
    assert.equal(exact.record.gate, bar, `${label} record.gate`)
    assert.equal(exact.record.recommendation, null, `${label}: nothing to recommend when it was applied`)

    const high = await triage({ decisionClass, complexity, confidence: above })
    assert.equal(high.outcome.substituted, true, `${label} above`)
  }
})

test('both lanes obey the ladder: Point B reports applicable instead of answering', async () => {
  const applied = await triage({ complexity: 'complex', confidence: 0.96, prefer: 'timeout-fallback', humanTimedOut: true })
  assert.equal(applied.outcome.answer, null, 'Point B never answers the settled call')
  assert.equal(applied.outcome.substituted, false)
  assert.equal(applied.outcome.applicable, true, 'but the verdict is applicable at the lifecycle level')
  assert.equal(applied.record.escalate_at, null, 'nothing is stalled when it was applicable')
  const missed = await triage({ complexity: 'complex', confidence: 0.94, prefer: 'timeout-fallback', humanTimedOut: true })
  assert.equal(missed.outcome.applicable, false)
  assert.equal(missed.record.escalate_at, 1000 + 3_600_000, 'a near miss stays blocked and escalates')
  assert.equal(missed.record.recommendation?.choice, 'Approve')
})

test('the operator floor sits under every band bar', async () => {
  const { record } = await triage({ complexity: 'complex', confidence: 0.9, config: triageConfig({ confidenceThreshold: 0.97 }) })
  assert.equal(record.gate, 0.97)
})

/* ───────────────────────── armable gate + receipts ────────────────────────── */

test('an armed gate applies at or above its band bar, and is flagged for post-hoc review', async () => {
  const config = { classes: { 'gate.approval': 'triage' } }
  const applied = await triage({ decisionClass: 'gate.approval', complexity: 'complex', confidence: 0.96, config })
  assert.equal(applied.outcome.substituted, true)
  assert.equal(applied.record.requires_post_hoc_review, true)
  assert.match(String(applied.record.code), /substituted/)
  const missed = await triage({ decisionClass: 'gate.approval', complexity: 'complex', confidence: 0.94, config })
  assert.equal(missed.outcome.substituted, false)
  assert.equal(missed.record.recommendation?.choice, 'Approve')
  // and at the default (advisory) it never applies, whatever the confidence
  const advisory = await triage({ decisionClass: 'gate.approval', complexity: 'trivial', confidence: 1, config: {} })
  assert.equal(advisory.outcome.substituted, false)
  assert.equal(advisory.outcome.code, 'advisory-only')
})

test('SAFETY: an AUTO receipt for a gate never becomes a human receipt, even with the gate armed', async (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo', { stateOverrides: { phase: 'gate1', gates: { gate1: 'pending' } }, ledgerText: null })
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool), get: () => undefined }, logger: () => ({ warn() {}, error() {}, info() {} }) }
  const registered = registerTools({
    ctx,
    deps: {
      config: { audit: { path: 'docs/aidlc/decision-audit.jsonl' }, decision: { classes: { 'gate.approval': 'triage' }, model: {} } },
      log: { warn() {}, error() {}, info() {} },
      state: stateApi,
      ledger: ledgerApi,
      audit: { write: () => ({ ok: true }) },
      classify,
      resolveMode,
    },
  })
  if (registered.ok === false) {
    t.skip('@deepseek-ai/dsh-tools is not installed in this checkout')
    return
  }
  const record = tools.find((tool) => tool.name === 'aidlc_record_decision')
  const exec = { agent: { session: { header: { cwd: root } } } }
  write(`${dir}/decisions.md`, 'seed\n')

  // the human receipt is still unforgeable through the tool
  for (const verbatim of ['GATE-APPROVED gate1 2026-10-20', 'the human said\nGATE-APPROVED gate1 2026-10-20\n', 'GATE-REJECTED gate2 2026-10-20']) {
    await assert.rejects(() => record.execute({ slug: 'demo', kind: 'feedback', verbatim }, exec), `/receipt line/`)
  }
  assert.equal(readLedger(`${root}/docs/aidlc/demo`), 'seed\n', 'every refusal leaves the ledger untouched')

  // the AUTO receipt for that gate can exist now...
  const auto = await record.execute({ slug: 'demo', kind: 'auto', gate: 'gate1', autoVerdict: 'AUTO-APPROVED', by: 'systemone', confidence: 0.96 }, exec)
  assert.equal(auto.ok, true)
  // ...and is still inert for the gate rule
  const ledger = readLedger(`${root}/docs/aidlc/demo`)
  assert.match(ledger, /AUTO-APPROVED gate1/)
  assert.equal(gateReceiptStatus(ledger, 'gate1').state, 'none', 'an AUTO receipt must never satisfy the gate rule')
})

/* ───────────────────────── levelFloors cannot be typo'd ──────────────────── */

test('levelFloors: a typo, a wrong type or an out-of-range value cannot lower a bar', async () => {
  for (const hostile of [
    { C3_COMPLEX: 0.1 },
    { C3_COMPLEX: '0.9x' },
    { C3_COMPLEX: NaN },
    { C3_COMPLEX: 2 },
    { C3_COMPLEX: -1 },
    { C3_COMPLEX: undefined },
    { C3_COMPLEX: {} },
    { C3_COMPLEX: [] },
    { C3_COMPLEX: true },
    'nonsense',
    null,
  ]) {
    const normalized = normalizeDecisionConfig({ levelFloors: hostile })
    assert.equal(gateForLevel('C3_COMPLEX', 0.6, normalized.levelFloors), 0.95, JSON.stringify(hostile))
    assert.equal(gateForLevel('C2_SIMPLE', 0.6, normalized.levelFloors), 0.85, JSON.stringify(hostile))
  }
  // a deliberate, valid raise IS honoured
  assert.equal(gateForLevel('C3_COMPLEX', 0.6, normalizeDecisionConfig({ levelFloors: { C3_COMPLEX: 0.97 } }).levelFloors), 0.97)
  // and the runtime path uses it (not just the helper)
  const raised = await triage({ complexity: 'complex', confidence: 0.96, config: triageConfig({ levelFloors: { C3_COMPLEX: 0.97 } }) })
  assert.equal(raised.record.gate, 0.97)
  assert.equal(raised.outcome.substituted, false, 'a valid raise tightens the band')

  // the schema refuses an out-of-range value outright (→ the wiring falls back to defaults)
  assert.throws(() => new Config({ decision: { levelFloors: { C3_COMPLEX: 0.1 } } }), /0\.5|expected number/)
  assert.throws(() => new Config({ decision: { levelFloors: { C3_COMPLEX: 2 } } }), /0\.5|expected number|<= 1/)
  assert.equal(new Config({ decision: { levelFloors: { C3_COMPLEX: 0.97 } } }).decision.levelFloors.C3_COMPLEX, 0.97)
})

test('bandThresholds reads the operator knobs and never goes below the floor', () => {
  const defaults = bandThresholds({ config: new Config({}) })
  assert.deepEqual(defaults, { floor: 0.6, simple: 0.85, complex: 0.95, source: 'config' })
  const raised = bandThresholds({ config: { decision: { levelFloors: { C3_COMPLEX: 0.97 } } } })
  assert.equal(raised.complex, 0.97)
  const floorRaised = bandThresholds({ config: { decision: { confidenceThreshold: 0.9, levelFloors: { C3_COMPLEX: 0.8 } } } })
  assert.equal(floorRaised.complex, 0.9, 'the operator floor is a floor under the band bar')
  const lines = bandThresholdLines({ config: new Config({}) })
  assert.equal(lines.length, 2)
  assert.match(lines[0], /C0\/C1 trivial -> 0\.6/)
  assert.match(lines[0], /C3 complex -> 0\.95/)
  assert.match(lines[1], /escalates to the human/)
})

test('configWarnings reports an armed gate and an inverted ladder', () => {
  const base = new Config({})
  const armed = { ...base, decision: { ...base.decision, classes: { ...base.decision.classes, 'gate.approval': 'triage' } } }
  const warnings = configWarnings(armed)
  assert.equal(warnings.length >= 1, true)
  assert.match(warnings[0], /gate\.approval/)
  assert.match(warnings[0], /AUTO-APPROVED/, 'the warning is the same text policy.js owns (no drift)')
  assert.deepEqual(configWarnings(base), [], 'the defaults are silent')
  const inverted = { ...base, decision: { ...base.decision, levelFloors: { ...base.decision.levelFloors, C2_SIMPLE: 0.9, C3_COMPLEX: 0.7 } } }
  assert.equal(configWarnings(inverted).some((line) => /inverts the risk ladder/.test(line)), true)
})

/* ─────────────────────── the surface panel / mode rows ───────────────────── */

test('modeRows shows the effective mode, the configured value and the clamp', () => {
  const base = new Config({})
  const deps = { config: base, resolveMode }
  const rows = modeRows(deps)
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  for (const id of NEVER_AUTO) {
    assert.equal(byId[id].effective, 'hold', id)
    assert.equal(byId[id].authority, true, id)
  }
  assert.equal(byId['gate.approval'].effective, 'advisory')
  assert.equal(byId['gate.approval'].authority, false)
  assert.equal(byId['artifact.tweak'].effective, 'triage')
  // a hostile config for a judgment class is shown as clamped, not as armed
  const hostile = { config: { ...base, decision: { ...base.decision, classes: { ...base.decision.classes, 'unit.ordering': 'hold' } } }, resolveMode }
  const held = modeRows(hostile).find((row) => row.id === 'unit.ordering')
  assert.equal(held.effective, 'hold')
  assert.equal(held.configured, 'hold')
  assert.equal(held.clamped, false, 'an operator choosing hold is honoured, not "clamped"')
})

/* ───────────────────────────── the answerer (wiring) ─────────────────────── */

test('the answerer: triage claims above the bar, escalation leaves the question UNMODIFIED', async (t) => {
  let mod
  try {
    mod = await import('../lib/index.js')
  } catch (error) {
    t.skip(`harness packages unavailable (${error.message.split('\n')[0]})`)
    return
  }
  const root = tmpRoot(t)
  const originalCwd = process.cwd()
  const realFetch = globalThis.fetch
  let modelAnswer = { choice: 'Approve', confidence: 0.5, risk: 'low', reason: 'close call' }
  let transportCalls = 0
  let answer = null
  globalThis.fetch = async () => {
    transportCalls += 1
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(modelAnswer) } }] }), text: async () => '' }
  }
  const listeners = new Map()
  const warnings = []
  const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {}, info: () => {} }
  const ctx = {
    logger: () => log,
    on: (event, handler) => listeners.set(event, handler),
    effect: () => {},
    get: () => undefined,
    commands: { register: () => {} },
    tools: { register: () => {}, get: () => undefined },
  }
  try {
    process.chdir(root)
    answer = mod.apply
    // `interceptAllSessions` is required here: the answerer now only touches a
    // session that is in AIDLC mode (or an operator who opted into answering
    // questions everywhere). Without it the listener delegates immediately,
    // which is asserted separately below — that session scoping is the fix for
    // "questions the user needed to answer were answered by a model instead".
    mod.apply(ctx, {
      decision: {
        interceptAllSessions: true,
        model: { protocol: 'chat', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', timeoutMs: 5000 },
      },
    })
    const answerer = listeners.get('user-questions/request')
    assert.equal(typeof answerer, 'function', 'the plugin registers the question answerer')
    const mkReq = (overrides = {}) => ({
      id: 'req',
      questions: [{ id: 'q1', header: 'Tweak', question: 'Proceed with the tweak?', options: [{ label: 'Approve', description: 'go' }, { label: 'Reject', description: 'stop' }], ...overrides }],
      agent: { options: { provider: 'p', model: 'm' }, inject: () => {} },
    })

    // above the bar: claimed, no human
    transportCalls = 0
    modelAnswer = { choice: 'Approve', confidence: 0.99, risk: 'low', reason: 'obvious' }
    let nextCalls = 0
    const shaped = await answerer(mkReq(), async () => {
      nextCalls += 1
      return { kind: 'human' }
    })
    assert.equal(nextCalls, 0, 'a cleared triage must claim the question')
    assert.deepEqual(shaped, { answers: [{ id: 'q1', selected: ['Approve'] }] })

    // below the bar: the human is asked, with the recommendation injected
    transportCalls = 0
    modelAnswer = { choice: 'Approve', confidence: 0.5, risk: 'low', reason: 'close call' }
    const req = mkReq()
    const snapshot = JSON.parse(JSON.stringify(req.questions))
    const questionIdentity = req.questions[0]
    const injected = []
    req.agent.inject = (message) => injected.push(message)
    nextCalls = 0
    const humanResult = await answerer(req, async () => {
      nextCalls += 1
      return { kind: 'human' }
    })
    assert.equal(nextCalls, 1, 'a below-bar triage must defer to the human')
    assert.deepEqual(humanResult, { kind: 'human' }, 'and return the next() result unchanged')
    assert.equal(injected.length, 1, 'exactly one context injection')
    const text = JSON.stringify(injected[0])
    assert.match(text, /decision support/)
    assert.match(text, /Approve/)
    assert.match(text, /p_max/)
    assert.match(text, /close call/)
    // The "bar for this band" clause IS emitted now: the Lead fixed the read to
    // take the bar from the audit record (`outcome.record.gate`), where the
    // arbiter actually puts it, instead of from a non-existent `outcome.bar`.
    // This assertion was previously inverted and passed for the wrong reason —
    // the clause was absent because the information was misread, not by design.
    assert.equal(/bar for this band/.test(text), true)
    // THE invariant the Lead asked about: context is additive, never a question rewrite
    assert.deepEqual(req.questions, snapshot, 'the questions must be byte-identical after the escalation')
    assert.equal(req.questions[0], questionIdentity, 'and not even replaced by an equal copy')
    assert.equal(req.questions[0].options.length, 2)
    assert.equal(req.questions[0].options[0].description, 'go')

    // an inject failure must not stop the human's question
    const failing = mkReq()
    failing.agent.inject = () => {
      throw new Error('inject exploded')
    }
    nextCalls = 0
    const stillHuman = await answerer(failing, async () => {
      nextCalls += 1
      return { kind: 'human' }
    })
    assert.equal(nextCalls, 1)
    assert.deepEqual(stillHuman, { kind: 'human' })
    assert.equal(warnings.some((line) => /could not attach the decision-model recommendation/.test(line)), true)

    // advisory (the gate default) and hold (authority) never claim and never consult
    transportCalls = 0
    for (const [label, aidlcClass] of [['advisory', 'gate.approval'], ['authority', 'test.unlock']]) {
      let humanAsked = 0
      modelAnswer = { choice: 'Approve', confidence: 0.99, risk: 'low', reason: 'obvious' }
      await answerer(mkReq({ aidlcClass }), async () => {
        humanAsked += 1
        return { kind: 'human' }
      })
      assert.equal(humanAsked, 1, label)
      assert.equal(transportCalls, 0, `${label}: the model must not be consulted`)
    }

    // a C3 question is triaged on the ladder (complexity raises the bar, it does not forbid)
    const long = `${'long context '.repeat(80)}Proceed?`
    const c3 = classify({ id: 'q', question: long, options: [{ label: 'Approve' }, { label: 'Reject' }] }, {})
    assert.equal(c3.complexity, 'complex', 'precondition: the question is C3')
    transportCalls = 0
    modelAnswer = { choice: 'Approve', confidence: 0.96, risk: 'low', reason: 'obvious' }
    nextCalls = 0
    await answerer(mkReq({ question: long }), async () => {
      nextCalls += 1
      return { kind: 'human' }
    })
    assert.equal(nextCalls, 0, 'a C3 at 0.96 is applied')
    transportCalls = 0
    modelAnswer = { choice: 'Approve', confidence: 0.94, risk: 'low', reason: 'close' }
    const req3 = mkReq({ question: long })
    const injected3 = []
    req3.agent.inject = (message) => injected3.push(message)
    nextCalls = 0
    await answerer(req3, async () => {
      nextCalls += 1
      return { kind: 'human' }
    })
    assert.equal(nextCalls, 1, 'a C3 at 0.94 escalates')
    assert.equal(injected3.length, 1, '...carrying the recommendation')
  } finally {
    process.chdir(originalCwd)
    globalThis.fetch = realFetch
  }
})

/* ───────────────────────────── calibration note ──────────────────────────── */

test('CALIBRATION (FIXED): a TAGGED class no longer lowers the band — the tag and the wording agree at the class floor', () => {
  // The inversion this pins: a declared class skips the "inferred from wording →
  // simple" downgrade, so a tagged question used to land one band BELOW the same
  // content untagged — tagging, which the tool calls "the classifier's most
  // reliable input", bought the LEAST conservative bar on exactly the classes
  // whose wrong answers are expensive. `policy.js` now gives every
  // keyword-inferable class a `minLevel` floor, applied on both paths and in
  // both `classify()` and `arbiter()`, and it can only RAISE a band.
  //
  // Flipped from the observed-inversion pin to the fixed expectation (task-15).
  // This is a floor on the BAND (the bar), not a return to the old C3 veto: a
  // floored C2 design choice at 0.90 is still applied automatically.
  const band = (question, intent) => classify({ question, options: [{ label: 'A' }, { label: 'B' }], ...(intent ? { intent } : {}) }, {}).level
  // Tagged and untagged agree, at C2 or above, for every class a keyword can infer.
  assert.equal(band('Which one?', 'design.choice'), 'C2_SIMPLE')
  assert.equal(band('Pick the architecture approach'), 'C2_SIMPLE')
  assert.equal(band('Which one?', 'scope.expansion'), 'C2_SIMPLE')
  assert.equal(band('Should we add this new feature?'), 'C2_SIMPLE')
  assert.equal(band('Which one?', 'plan.confirmation'), 'C2_SIMPLE')
  assert.equal(band('Proceed with this plan?'), 'C2_SIMPLE')
  assert.equal(band('Which one?', 'unit.ordering'), 'C2_SIMPLE')
  assert.equal(band('Which unit should we build first?'), 'C2_SIMPLE')
  assert.equal(band('Which one?', 'artifact.tweak'), 'C2_SIMPLE')
  assert.equal(band('Fix the typo in the wording'), 'C2_SIMPLE')
  assert.equal(band('Which one?', 'gate.approval'), 'C2_SIMPLE')
  assert.equal(band('Approve gate 1?'), 'C2_SIMPLE')
  // A class with no keyword rule keeps the cheap lane: this is a floor, not a
  // blanket C2, so the tag cannot discount — but it does not tax either.
  assert.equal(band('Which one?', 'generic.question'), 'C1_TRIVIAL')
})

/* ─────────────────────────────── OPEN findings ────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────────
 * DEFECT 13 (MEDIUM, missing compensating control) — the loud warning that makes
 * `gate.approval` armable acceptable is never emitted.
 *
 * `lib/config.js:382` defines `configWarnings()`, which delegates the gate-arming
 * text to `policy.js` `armingWarning` (`config.js:390`) — the delegation is
 * correct. But NOTHING calls `configWarnings`: `lib/index.js:22` imports only
 * `{ Config, plainConfig, validateConfig }`, `validateConfig` returns `null` for
 * an armed gate by design, and no command/tool calls it either (grep: zero
 * callers outside config.js).
 *
 * So an operator who writes `decision.classes["gate.approval"]="triage"` gets no
 * warning at boot and no refusal from the validator: the only trace is the
 * `/aidlc-decisions` panel if they happen to run it, and that panel shows the
 * triage status line, not the "this lets a model pass a human gate; it is a
 * logged exception; leave it at advisory" text.
 *
 * Input:  `apply(ctx, {decision:{classes:{'gate.approval':'triage'}}})`.
 * Observed: no warning/error log line; `configWarnings(config)` (which would
 *         produce one) is never called.
 * Expected: the boot path logs the arming warnings (e.g. in `apply` after
 *         `validateConfig`), so the exception is loud — that is what the design
 *         says the warning is for ("the config validator prints this").
 * Fix shape: `for (const w of configWarnings(config)) log.warn(w)` in apply().
 * ───────────────────────────────────────────────────────────────────────────── */

test('DEFECT 13: arming gate.approval produces no warning anywhere', async (t) => {
  let mod
  try {
    mod = await import('../lib/index.js')
  } catch (error) {
    t.skip(`harness packages unavailable (${error.message.split('\n')[0]})`)
    return
  }
  const warnings = []
  const errors = []
  const listeners = new Map()
  const log = { warn: (...a) => warnings.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')), info: () => {} }
  const ctx = {
    logger: () => log,
    on: (event, handler) => listeners.set(event, handler),
    effect: () => {},
    get: () => undefined,
    commands: { register: () => {} },
    tools: { register: () => {}, get: () => undefined },
  }
  const originalCwd = process.cwd()
  const root = tmpRoot(t)
  try {
    process.chdir(root)
    mod.apply(ctx, { decision: { classes: { 'gate.approval': 'triage' } } })
  } finally {
    process.chdir(originalCwd)
  }
  const all = [...warnings, ...errors].join('\n')
  assert.match(all, /gate\.approval.*triage|lets a high-confidence model verdict pass a human gate/, 'arming the gate must be loud')
})

/* ─────────────────────────────────────────────────────────────────────────────
 * DEFECT 14 (MINOR, misleading message) — `validateConfig` names the wrong
 * spelling when it refuses an authority class.
 *
 * `lib/config.js:364` hardcodes `="substitute" is refused` in the message, but
 * the value the operator wrote may be `"triage"` (now the canonical spelling,
 * accepted by the schema at :122 and by `canonicalMode`). Writing
 * `{"test.unlock":"triage"}` is answered with a message about `"substitute"`.
 *
 * Input:  decision.classes["test.unlock"]="triage"
 * Observed: `decision.classes["test.unlock"]="substitute" is refused: …`
 * Expected: the message names what the operator wrote (`"triage"`), or both
 *         spellings explicitly.
 * ───────────────────────────────────────────────────────────────────────────── */

test('DEFECT 14: the authority-class refusal message names the wrong spelling', () => {
  const base = new Config({})
  const armed = { ...base, decision: { ...base.decision, classes: { ...base.decision.classes, 'test.unlock': 'triage' } } }
  const message = validateConfig(armed)
  assert.equal(typeof message, 'string')
  assert.match(message, /"triage" is refused/, `the message should name the operator's value "triage", got: ${message}`)
})
