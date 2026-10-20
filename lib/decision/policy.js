/**
 * Decision classes, substitution modes, and the never-auto clamp.
 *
 * This module is the safety core of the decision-model layer. Everything else
 * (classifier, transports, arbiter) is machinery; this file decides *whether*
 * machinery is allowed to answer at all.
 *
 * The doctrine, in one sentence: a decision model is a convenience for cheap,
 * reversible decisions, so the code — never the config — owns the set of
 * classes that may not be automated.
 *
 * @module dsh-aidlc/decision/policy
 */

/**
 * Decision classes. Stable ids; they appear in config, receipts and audit
 * records. `neverAuto` is the authoritative per-class statement; `defaultMode`
 * is what the class resolves to when the operator has not overridden it.
 *
 * `reversible` has two jobs: it tells the arbiter whether a substituted verdict
 * may stand at all, and it feeds the classifier's trivial/simple test.
 *
 * `minLevel` is the class's own FLOOR on its confidence band, applied on every
 * path (tagged or inferred) in both `classify()` and `arbiter()`. It exists to
 * close one specific inversion: the classifier's "inferred from wording ⇒
 * simple" downgrade means a *tagged* question would otherwise land one band
 * BELOW the same question untagged — so using the input the tool description
 * calls "the classifier's most reliable input" would buy the *least*
 * conservative bar. A tag must not be a discount. It is a floor on the band, not
 * a veto: a C2 design choice at 0.90 is still applied. It may be raised by
 * `decision.classMinLevels`, never lowered.
 *
 * @typedef {{neverAuto:boolean, defaultMode:'hold'|'advisory'|'triage'|'substitute', reversible:boolean, minLevel?:'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'}} DecisionClassDefinition
 */

/** @type {Record<string, DecisionClassDefinition>} */
export const DECISION_CLASSES = {
  // The human gate. NOT an authority class: the always-human rule is the
  // original plugin's own process decision ("门禁永不自动"), so it is the
  // DEFAULT, not a clamp. An operator who accepts the risk may arm it for
  // `triage`; `policy.js` warns loudly instead of refusing, because a rule the
  // operator cannot lift is a limitation, not a rule.
  //
  // `reversible: true` is a consequence of that arming, not a downgrade: a gate
  // verdict applied by triage is undone by the same veto window as every other
  // class, and a class that COULD be applied but is marked irreversible would
  // simply never be applied — the operator's choice would be inert. The six
  // authority classes stay irreversible because for them the veto window is
  // irrelevant: they are never consulted in the first place.
  'gate.approval': { neverAuto: false, defaultMode: 'advisory', reversible: true, minLevel: 'C2_SIMPLE' },
  // --- Judgment classes: consulted FIRST, escalated only when the model is not
  // confident enough. This is the user's correction: the model is a triage
  // layer — humans are not removed, unnecessary human interruptions are.
  // Every class reachable by a keyword rule carries `minLevel: 'C2_SIMPLE'`, so
  // that inference — the conservative path — sets the bar and a tag can only
  // match it. `gate.reject-feedback` and `generic.question` have no keyword rule,
  // so a tag is the only way in and there is nothing to be inconsistent with.
  'gate.reject-feedback': { neverAuto: false, defaultMode: 'triage', reversible: true },
  'design.choice': { neverAuto: false, defaultMode: 'triage', reversible: true, minLevel: 'C2_SIMPLE' },
  'scope.expansion': { neverAuto: false, defaultMode: 'triage', reversible: true, minLevel: 'C2_SIMPLE' },
  'plan.confirmation': { neverAuto: false, defaultMode: 'triage', reversible: true, minLevel: 'C2_SIMPLE' },
  'unit.ordering': { neverAuto: false, defaultMode: 'triage', reversible: true, minLevel: 'C2_SIMPLE' },
  'artifact.tweak': { neverAuto: false, defaultMode: 'triage', reversible: true, minLevel: 'C2_SIMPLE' },
  'generic.question': { neverAuto: false, defaultMode: 'triage', reversible: true },
  // --- Authority classes. Every one defaults to `hold` and is clamped in code:
  // the model is not consulted at all, and the human answers. They exist as
  // NAMED classes so the clamp can say which refusal applied.
  /** Unlocking tests removes the check that would catch a bad decision. */
  'test.unlock': { neverAuto: true, defaultMode: 'hold', reversible: false },
  /** Accepting a new test baseline: otherwise "new failures = regression" stops meaning anything. */
  'test.baseline': { neverAuto: true, defaultMode: 'hold', reversible: false },
  /** Credentials, secrets, sandbox/guard bypass, `--force`, `danger-full-access`. */
  'security.exception': { neverAuto: true, defaultMode: 'hold', reversible: false },
  /** Force-push, publish, deploy, migration, external writes, deleting committed artifacts. */
  'irreversible.operation': { neverAuto: true, defaultMode: 'hold', reversible: false },
  /** The decision policy, its thresholds, NEVER_AUTO, or a question's own class. */
  'policy.change': { neverAuto: true, defaultMode: 'hold', reversible: false },
  /** An authorization-like answer when the state carries text authored outside the repo. */
  'untrusted.authorization': { neverAuto: true, defaultMode: 'hold', reversible: false },
}

/** Every known decision-class id, in declaration order. */
export const DECISION_CLASS_IDS = Object.freeze(Object.keys(DECISION_CLASSES))

/**
 * The classes no configuration value can arm for `triage`.
 *
 * Six authority-only classes: `test.unlock`, `test.baseline`,
 * `security.exception`, `irreversible.operation`, `policy.change`,
 * `untrusted.authorization`.
 *
 * Enforced in `resolveMode()` in code. The config validator refuses such a
 * config as well, but this clamp is the one that actually holds: a config that
 * never went through the validator (a hand-built object, a future config
 * format, a caller that passes a raw object literal) still cannot arm these.
 *
 * Note what this set is NOT: it is not a list of "risky" classes. It is the
 * list of decisions whose *author* must be a human — a machine answer would be
 * a forgery of a human act, not merely a wrong answer. That is why the gate
 * class is deliberately absent from it: a gate approval is a judgment a
 * confidence bar can express, while "may I have the credentials" is not.
 */
export const NEVER_AUTO = new Set(Object.entries(DECISION_CLASSES).filter(([, def]) => def.neverAuto).map(([id]) => id))

/**
 * The ZCode/DSH receipt vocabulary, restated here because a future refactor
 * would otherwise be tempted to "simplify" it:
 *
 *  - `GATE-APPROVED` is a HUMAN verdict. It is the only thing that satisfies a
 *    gate receipt, and **no code in this plugin may ever write one**. A machine
 *    that could write it could forge a human approval, and the whole audit
 *    chain becomes worthless.
 *  - `AUTO-APPROVED` is the machine's distinct receipt. It is written by the
 *    lifecycle layer (lib/aidlc/ledger.js), never here, and it satisfies a gate
 *    only when the decision class is armed for `triage` (design.md §4.3).
 *
 * Since `gate.approval` became armable (task-14), an operator CAN configure a
 * gate whose AUTO receipt counts. That is their explicit, warned choice, and it
 * is exactly why the two receipt kinds stay distinct: what makes forgery
 * impossible is not that arming is refused, it is that the machine never writes
 * the human's word.
 *
 * `lib/decision/*` produces decisions and audit records only; it writes no
 * receipts at all, which is what keeps the two kinds impossible to confuse.
 */
export const AUTO_RECEIPT_KIND = 'AUTO-APPROVED'
/** The human receipt kind this layer must never emit. */
export const HUMAN_RECEIPT_KIND = 'GATE-APPROVED'

/**
 * The four-level decision taxonomy (System-0 → System-2 routing).
 *
 *  - `C0_COMPUTED` — a deterministic resolver answers; no model, no human.
 *  - `C1_TRIVIAL`  — a model may answer at the floor threshold.
 *  - `C2_SIMPLE`   — a model may answer at the high threshold.
 *  - `C3_COMPLEX`  — a model may answer only at near-certainty (0.95); below
 *    that the decision escalates to the human carrying the recommendation.
 */
export const DECISION_LEVELS = Object.freeze(['C0_COMPUTED', 'C1_TRIVIAL', 'C2_SIMPLE', 'C3_COMPLEX'])

/**
 * The complexity LADDER: complexity raises the BAR, it does not forbid the
 * decision. This is the user's correction to the earlier design, where a C3
 * classification refused automation outright — which made a decision the model
 * could call at 96% still interrupt a person.
 *
 * C0/C1 → the configured floor (0.60) · C2 → 0.85 · C3 → 0.95 (near-certainty).
 *
 * The durable part of the vendor's guidance is the STRUCTURE — a floor plus a
 * higher bar per band — not the constants; one TypeSafe page says 0.6/0.85,
 * another 0.5/0.9. The numbers are therefore calibratable through
 * `decision.levelFloors`, and the operator's `confidenceThreshold` remains the
 * floor under all of them.
 */
export const LEVEL_FLOOR = Object.freeze({
  C0_COMPUTED: 0.6,
  C1_TRIVIAL: 0.6,
  C2_SIMPLE: 0.85,
  C3_COMPLEX: 0.95,
})

/** Map the frozen `complexity` vocabulary onto the taxonomy. */
export const COMPLEXITY_TO_LEVEL = Object.freeze({
  trivial: 'C1_TRIVIAL',
  simple: 'C2_SIMPLE',
  complex: 'C3_COMPLEX',
})

/** The inverse map: the taxonomy level's `complexity` spelling. */
export const LEVEL_TO_COMPLEXITY = Object.freeze({
  C0_COMPUTED: 'trivial',
  C1_TRIVIAL: 'trivial',
  C2_SIMPLE: 'simple',
  C3_COMPLEX: 'complex',
})

/**
 * The tier a level sits in. `C0_COMPUTED` and `C1_TRIVIAL` share the trivial
 * tier: they differ in *who answers* (a resolver vs the model), not in how
 * risky the decision is.
 */
export const LEVEL_TIER = Object.freeze({ C0_COMPUTED: 0, C1_TRIVIAL: 0, C2_SIMPLE: 1, C3_COMPLEX: 2 })

/** Tier index -> the level that spells it. */
export const TIER_LEVEL = Object.freeze(['C1_TRIVIAL', 'C2_SIMPLE', 'C3_COMPLEX'])

/** Tier index -> the `complexity` that spells it. */
export const TIER_COMPLEXITY = Object.freeze(['trivial', 'simple', 'complex'])

/**
 * Reconcile any number of level spellings into ONE answer.
 *
 * The rule is the highest tier any spelling names — never the first one, never
 * the last one, and never a precedence chain. A caller that says `'complex'` in
 * one field and `'trivial'` in another does not get to pick the cheaper one;
 * that is the D2/D12 defect class (two spellings of one fact disagreeing, with
 * the fail-closed direction losing), and this is the single primitive that
 * closes it for `classify()`, `arbiter()` and the per-class `minLevel` floor.
 *
 * Spellings may be taxonomy levels (`C1_TRIVIAL`) or the frozen complexity
 * vocabulary (`trivial`); a complexity spelling asserts a TIER but says nothing
 * about C0 vs C1, so `C0_COMPUTED` survives alongside `trivial`.
 *
 * An unrecognised or non-string spelling fails closed to the most complex tier,
 * like everything else in this layer. Nothing supplied at all is the only case
 * that returns `null`, because "no information" and "garbage information" are
 * different facts and only the caller can tell them apart.
 *
 * Lives in `policy.js` (with the tier tables) so that `applyClassMinLevel` can
 * use it without `policy.js` importing `classify.js`; `classify.js` re-exports
 * both functions so their long-standing import site keeps working.
 *
 * @param {...(string|undefined|null)} spellings
 * @returns {{level:'C0_COMPUTED'|'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX', complexity:'trivial'|'simple'|'complex'}|null}
 */
export function reconcileLevels(...spellings) {
  const supplied = spellings.filter((value) => value !== undefined && value !== null && value !== '')
  if (supplied.length === 0) return null
  let tier = 0
  let sawLevelSpelling = false
  let everyLevelSpellingIsC0 = true
  for (const raw of supplied) {
    const isLevel = typeof raw === 'string' && LEVEL_TIER[raw] !== undefined
    const asLevel = isLevel
      ? raw
      : typeof raw === 'string' && COMPLEXITY_TO_LEVEL[raw] !== undefined
        ? COMPLEXITY_TO_LEVEL[raw]
        : null // unrecognised -> fail closed
    const candidateTier = asLevel === null ? 2 : LEVEL_TIER[asLevel]
    if (candidateTier > tier) tier = candidateTier
    if (isLevel) {
      sawLevelSpelling = true
      if (raw !== 'C0_COMPUTED') everyLevelSpellingIsC0 = false
    }
  }
  if (tier === 0) {
    return { level: sawLevelSpelling && everyLevelSpellingIsC0 ? 'C0_COMPUTED' : 'C1_TRIVIAL', complexity: 'trivial' }
  }
  return { level: TIER_LEVEL[tier], complexity: TIER_COMPLEXITY[tier] }
}

/**
 * Re-derive `level` and `complexity` from the single highest tier either of them
 * reached. This is the D2 invariant, enforced at one place: the two fields are
 * two spellings of one answer, so a caller that branches on `complexity` (the
 * live wiring does) can never miss a promotion decided on `level`.
 *
 * A thin wrapper over {@link reconcileLevels}; with nothing supplied at all it
 * fails closed to C3, because a function asked to reconcile *declared* things
 * has no safe default other than the most conservative one.
 *
 * @param {string} level
 * @param {string} complexity
 * @returns {{level:'C0_COMPUTED'|'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX', complexity:'trivial'|'simple'|'complex'}}
 */
export function reconcileLevel(level, complexity) {
  return reconcileLevels(level, complexity) ?? { level: 'C3_COMPLEX', complexity: 'complex' }
}

/**
 * The bands a `minLevel` may name. `C0_COMPUTED` is deliberately excluded: it is
 * not a confidence band at all (a deterministic resolver answers, so there is no
 * bar), and treating it as one would let a floor *disable* `confidenceThreshold`.
 *
 * @type {ReadonlyArray<'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'>}
 */
export const MIN_LEVEL_BANDS = Object.freeze(['C1_TRIVIAL', 'C2_SIMPLE', 'C3_COMPLEX'])

/**
 * The band floor for one class: the configured override when it is a genuine
 * RAISE, otherwise the class's own `minLevel`, otherwise nothing.
 *
 * @param {string} decisionClass
 * @param {unknown} [config]
 * @returns {'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'|null}
 */
export function minLevelOf(decisionClass, config) {
  const definition = classDefinition(decisionClass)
  const builtin = definition && MIN_LEVEL_BANDS.includes(/** @type {any} */ (definition.minLevel)) ? definition.minLevel : null
  const requested = normalizeDecisionConfig(config).classMinLevels?.[decisionClass]
  if (!requested) return builtin
  // Upward only: an override may raise a class's floor, never lower it. Adding a
  // floor to a class that had none is a raise by definition.
  if (builtin !== null && LEVEL_TIER[requested] <= LEVEL_TIER[builtin]) return builtin
  return requested
}

/**
 * Raise `level` to the class's band floor. Never lowers it.
 *
 * `C0_COMPUTED` passes through untouched: a deterministic allow-rule is an
 * operator-authored literal, not a model judgement, so it is not a confidence
 * band and the floor does not apply to it. Raising a C0 result to C2 would
 * silently disable the operator's own allow-rule for that class, which is a
 * different change from the one this floor exists to make.
 *
 * @param {string} decisionClass
 * @param {string|null|undefined} level
 * @param {unknown} [config]
 * @returns {string|null|undefined} the floored level.
 */
export function applyClassMinLevel(decisionClass, level, config) {
  if (level === 'C0_COMPUTED') return level
  const floor = minLevelOf(decisionClass, config)
  if (!floor) return level
  return reconcileLevels(floor, level)?.level ?? floor
}

/**
 * The bar a level's verdict must clear: the operator's floor, or the band's own
 * bar, whichever is higher. `null` (unclassified) uses the operator's floor.
 *
 * @param {string|null|undefined} level
 * @param {number} threshold operator floor.
 * @param {Record<string, number>|null} [floors] configured overrides for the ladder.
 * @returns {number}
 */
export function gateForLevel(level, threshold, floors = null) {
  const table = floors && typeof floors === 'object' ? { ...LEVEL_FLOOR, ...floors } : LEVEL_FLOOR
  const floor = level && Object.prototype.hasOwnProperty.call(table, level) ? Number(table[level]) : null
  const usable = typeof floor === 'number' && Number.isFinite(floor) ? floor : null
  return usable === null ? threshold : Math.max(threshold, usable)
}

/**
 * The three resolution modes, most restrictive first.
 *
 * `triage` is the canonical spelling of "consult the model first, apply the
 * verdict if it clears the band's bar, otherwise escalate to the human carrying
 * the recommendation". `substitute` is a documented ALIAS for it: the
 * behaviour is identical, and `resolveMode()` normalises both to `triage` so
 * that this layer never has two spellings of one fact to keep in sync.
 */
export const DECISION_MODES = Object.freeze(['hold', 'advisory', 'triage'])

/** The accepted alias of `triage`, kept for existing configs and tests. */
export const MODE_ALIASES = Object.freeze({ substitute: 'triage' })

/**
 * Normalise a mode spelling to its canonical form.
 *
 * @param {unknown} mode
 * @returns {'hold'|'advisory'|'triage'|null} the canonical mode, or null when unrecognised.
 */
export function canonicalMode(mode) {
  if (mode === 'hold' || mode === 'advisory' || mode === 'triage') return mode
  if (mode === 'substitute') return 'triage'
  return null
}

/** True for a mode this layer can act on (canonical or alias). */
export function isKnownMode(mode) {
  return canonicalMode(mode) !== null
}

/**
 * Fallback used when the caller passes no config at all. Mirrors the defaults
 * in lib/config.js; kept in sync with that file's `decision` block (see
 * docs/decision-model.md §"Defaults" for the reasoning behind each number).
 */
export const DEFAULT_DECISION_CONFIG = Object.freeze({
  enabled: true,
  classes: Object.freeze({}),
  timeoutMs: 900_000,
  escalateAfterMs: 3_600_000,
  confidenceThreshold: 0.6,
  onLowConfidence: 'block',
  vetoWindowMs: 600_000,
  blockOnCriticalRisk: true,
  levelFloors: Object.freeze({}),
  classMinLevels: Object.freeze({}),
  classify: Object.freeze({ deterministicTrivial: true, allowRules: Object.freeze([]) }),
  model: Object.freeze({
    protocol: 'session',
    baseURL: '',
    model: '',
    apiKey: '',
    apiKeyEnv: '',
    apiKeyFile: '',
    timeoutMs: 24_000,
    maxTokens: 1024,
    maxLen: 0,
    thinking: 'off',
    extraPolicy: '',
  }),
})

/** True for a class that may never be automated, from the set OR the definition. */
export function isNeverAuto(decisionClass) {
  if (NEVER_AUTO.has(decisionClass)) return true
  return DECISION_CLASSES[decisionClass]?.neverAuto === true
}

/**
 * The class definition, or `null` for an unknown id.
 *
 * @param {string} decisionClass
 * @returns {DecisionClassDefinition|null}
 */
export function classDefinition(decisionClass) {
  return Object.prototype.hasOwnProperty.call(DECISION_CLASSES, decisionClass) ? DECISION_CLASSES[decisionClass] : null
}

/**
 * Strip schemastery's volatile wrappers (`.get()`) so a parsed config can be
 * read as plain data. Local copy of lib/config.js `plainConfig`, deliberately
 * duplicated: lib/decision/* must not import a module that pulls in
 * `@deepseek-ai/schemastery`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function unwrap(value) {
  if (value === null || typeof value !== 'object') return value
  const wrapper = /** @type {{get?: unknown}} */ (value)
  if (typeof wrapper.get === 'function') {
    try {
      return unwrap(/** @type {() => unknown} */ (wrapper.get)())
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map(unwrap)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = unwrap(v)
  return out
}

/** A finite number, or the fallback. Never widens a bound. */
function numberOr(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * Normalise the caller's config into the shape this layer reads.
 *
 * Accepts either a full plugin config (`{decision:{...}}`) or a bare decision
 * config. Invalid values collapse to the safe side of their own bound:
 * a threshold outside [0.5, 1] is clamped *up* into range (a lax threshold is
 * the dangerous direction), an unreadable `onLowConfidence` becomes `block`,
 * and a missing `blockOnCriticalRisk` becomes `true`.
 *
 * @param {unknown} config - full plugin config, decision sub-config, or nothing.
 * @returns {typeof DEFAULT_DECISION_CONFIG & {classes: Record<string,'hold'|'advisory'|'triage'>, classify: {deterministicTrivial:boolean, allowRules:object[]}, levelFloors: Record<string, number>, model: Record<string, unknown>}} resolved decision config.
 */
export function normalizeDecisionConfig(config) {
  const raw = unwrap(config)
  const d = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (/** @type {Record<string, unknown>} */ (raw).decision && typeof /** @type {Record<string, unknown>} */ (raw).decision === 'object'
        ? /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (raw).decision)
        : /** @type {Record<string, unknown>} */ (raw))
    : {}

  /** @type {Record<string,'hold'|'advisory'|'triage'>} */
  const classes = {}
  const requested = d.classes && typeof d.classes === 'object' ? /** @type {Record<string, unknown>} */ (d.classes) : {}
  for (const id of DECISION_CLASS_IDS) {
    // Canonicalised here as well as in resolveMode: `substitute` and `triage`
    // are one behaviour, and keeping both spellings alive inside the layer is
    // how two-places-to-change bugs start.
    const mode = canonicalMode(requested[id]) ?? canonicalMode(DECISION_CLASSES[id].defaultMode) ?? 'hold'
    classes[id] = mode
  }

  // The complexity ladder is calibratable per band. Only known levels with a
  // finite probability are accepted; anything else falls back to the built-in
  // bar, so a typo cannot silently LOWER a bar.
  /** @type {Record<string, number>} */
  const levelFloors = {}
  const requestedFloors = d.levelFloors && typeof d.levelFloors === 'object' ? /** @type {Record<string, unknown>} */ (d.levelFloors) : {}
  for (const level of DECISION_LEVELS) {
    const value = requestedFloors[level]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 1) levelFloors[level] = value
  }

  // Per-class BAND floors are the one setting that is deliberately not
  // symmetric: an operator may raise a class's floor (a class they know is
  // expensive in their repository) but never lower it below the built-in one.
  // Lowering is what the floor exists to prevent.
  /** @type {Record<string, 'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'>} */
  const classMinLevels = {}
  const requestedMinLevels = d.classMinLevels && typeof d.classMinLevels === 'object' ? /** @type {Record<string, unknown>} */ (d.classMinLevels) : {}
  for (const [id, wanted] of Object.entries(requestedMinLevels)) {
    if (!DECISION_CLASS_IDS.includes(id)) continue
    if (!MIN_LEVEL_BANDS.includes(/** @type {any} */ (wanted))) continue
    const builtin = DECISION_CLASSES[id].minLevel
    if (builtin !== undefined && LEVEL_TIER[/** @type {any} */ (wanted)] <= LEVEL_TIER[builtin]) continue
    classMinLevels[id] = /** @type {'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'} */ (wanted)
  }

  const classify = d.classify && typeof d.classify === 'object' ? /** @type {Record<string, unknown>} */ (d.classify) : {}
  const model = d.model && typeof d.model === 'object' ? /** @type {Record<string, unknown>} */ (d.model) : {}

  return {
    enabled: typeof d.enabled === 'boolean' ? d.enabled : true,
    classes,
    timeoutMs: numberOr(d.timeoutMs, DEFAULT_DECISION_CONFIG.timeoutMs, 0, 86_400_000),
    escalateAfterMs: numberOr(d.escalateAfterMs, DEFAULT_DECISION_CONFIG.escalateAfterMs, 0, 86_400_000),
    // Clamped up into [0.5, 1]: a threshold below 0.5 would arm triage on
    // a coin flip, which is the direction an attacker (or a typo) would pick.
    confidenceThreshold: numberOr(d.confidenceThreshold, DEFAULT_DECISION_CONFIG.confidenceThreshold, 0.5, 1),
    onLowConfidence: d.onLowConfidence === 'block' || d.onLowConfidence === 'advisory' || d.onLowConfidence === 'defer-model'
      ? d.onLowConfidence
      : 'block',
    vetoWindowMs: numberOr(d.vetoWindowMs, DEFAULT_DECISION_CONFIG.vetoWindowMs, 0, 86_400_000),
    blockOnCriticalRisk: typeof d.blockOnCriticalRisk === 'boolean' ? d.blockOnCriticalRisk : true,
    levelFloors,
    classMinLevels,
    classify: {
      deterministicTrivial: typeof classify.deterministicTrivial === 'boolean' ? classify.deterministicTrivial : true,
      /**
       * Option-order bias mitigation. Jev-class models reportedly lean toward
       * the first option presented, so a verdict that only just clears the gate
       * is re-asked with the option order reversed; the two answers must agree.
       * Recorded either way as `retry_reversed`/`agreement` in the audit.
       */
      recheckReversed: typeof classify.recheckReversed === 'boolean' ? classify.recheckReversed : true,
      allowRules: Array.isArray(classify.allowRules) ? classify.allowRules.filter((r) => r && typeof r === 'object').map((r) => ({ .../** @type {object} */ (r) })) : [],
    },
    model: { ...DEFAULT_DECISION_CONFIG.model, ...model },
  }
}

/**
 * Resolve the mode for one decision class.
 *
 * Order of refusal, all in code:
 *  1. unknown class      -> `hold`  (we cannot reason about a class we do not know)
 *  2. decision layer off -> `hold`  (the master switch means "as before this plugin existed")
 *  3. authority class    -> never above its own `defaultMode`, so `triage` is clamped
 *  4. otherwise the configured mode, or the class default (usually `triage`).
 *
 * `substitute` is normalised to `triage` on the way out, so this layer has one
 * canonical spelling of "consult first, escalate if not confident".
 *
 * @param {{decisionClass?: string, config?: unknown}} input
 * @returns {'hold'|'advisory'|'triage'}
 */
export function resolveMode({ decisionClass, config } = {}) {
  const definition = classDefinition(decisionClass)
  if (!definition) return 'hold'
  const cfg = normalizeDecisionConfig(config)
  if (cfg.enabled === false) return 'hold'
  const requested = cfg.classes[decisionClass] ?? canonicalMode(definition.defaultMode) ?? 'hold'
  if (isNeverAuto(decisionClass)) {
    // `hold` is always allowed (stricter than the default); `advisory` is the
    // ceiling. A request for `triage` is silently clamped — loudly, in the audit
    // record, where the operator will see it. This clamp is the authority rule
    // and it has NOT moved: six classes, at any confidence, ever.
    if (requested === 'hold') return 'hold'
    return definition.defaultMode === 'hold' ? 'hold' : 'advisory'
  }
  return requested
}

/**
 * Whether a triaged verdict may be APPLIED for this class under this config
 * (subject to the arbiter's own gates: mode, band bar, risk, confidence).
 *
 * Deliberately exactly `resolveMode(...) === 'triage'`: this is the same
 * question the arbiter asks, and two code paths answering it differently is how
 * a clamp gets bypassed.
 *
 * @param {string} decisionClass
 * @param {unknown} config
 * @returns {boolean}
 */
export function isSubstitutable(decisionClass, config) {
  return resolveMode({ decisionClass, config }) === 'triage'
}

/**
 * A loud warning for a configuration the operator may legitimately write but
 * should not write by accident. `null` when there is nothing to say.
 *
 * `gate.approval` is the one class whose always-human rule is a *process*
 * commitment rather than a safety property, so it is armable — with a warning
 * instead of a refusal, because a rule the operator cannot lift is a limitation,
 * not a rule. The config validator prints this; the code clamp covers the six
 * authority classes and does not need a warning.
 *
 * @param {string} decisionClass
 * @param {unknown} mode
 * @returns {string|null}
 */
export function armingWarning(decisionClass, mode) {
  const canonical = canonicalMode(mode)
  if (decisionClass !== 'gate.approval' || canonical !== 'triage') return null
  return 'decision.classes["gate.approval"]="triage" lets a high-confidence model verdict pass a human gate. '
    + 'The AI-DLC methodology\'s own rule is that gates are never automatic ("门禁永不自动"), so this is a deliberate, '
    + 'logged exception you are opting into: every gate passed this way is recorded as an AUTO-APPROVED receipt, is '
    + 'reversible only inside the veto window, and is tagged requires_post_hoc_review in the decision audit. Leave it '
    + 'at "advisory" unless you have decided that a stalled gate is worse than an unreviewed one.'
}

/**
 * Whether a class is reversible (a substituted verdict can be undone inside the
 * veto window). Unknown classes are treated as irreversible.
 *
 * @param {string} decisionClass
 * @returns {boolean}
 */
export function isReversible(decisionClass) {
  return classDefinition(decisionClass)?.reversible === true
}

/**
 * Human-readable one-liner for an audit record: "artifact.tweak -> substitute".
 *
 * @param {string} decisionClass
 * @param {unknown} config
 * @returns {string}
 */
export function describeMode(decisionClass, config) {
  return `${decisionClass} -> ${resolveMode({ decisionClass, config })}`
}

/**
 * The mode SPELLING the operator actually wrote for a class, or null when the
 * class default applied. `resolveMode` canonicalises (`substitute` -> `triage`),
 * so this exists only so the audit can show the operator their own word next to
 * the behaviour it produced.
 *
 * @param {unknown} config
 * @param {string} decisionClass
 * @returns {string|null}
 */
export function rawConfiguredMode(config, decisionClass) {
  const raw = unwrap(config)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const container = /** @type {Record<string, unknown>} */ (raw)
  const d = container.decision && typeof container.decision === 'object' && !Array.isArray(container.decision)
    ? /** @type {Record<string, unknown>} */ (container.decision)
    : container
  const classes = d.classes && typeof d.classes === 'object' && !Array.isArray(d.classes) ? /** @type {Record<string, unknown>} */ (d.classes) : {}
  const value = classes[decisionClass]
  return typeof value === 'string' ? value : null
}

/** Option labels a question offers, in presentation order. */
function labelsOf(question) {
  return (Array.isArray(question?.options) ? question.options : [])
    .map((option) => (option && typeof option.label === 'string' ? option.label : null))
    .filter((label) => typeof label === 'string' && label.trim() !== '')
}

/** The text an allow-rule's `contains` clause is matched against. */
function textOf(question) {
  return [question?.header, question?.question, question?.detail]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n')
}

/**
 * The allow-rule matcher, copied in spirit and in strictness from the shipping
 * guardian's `matchAllowRule`.
 *
 * It is deliberately inexpressive: an exact, *known* decision class; a literal
 * option label that the question actually offers; an optional literal
 * substring. An empty or unknown class is never a wildcard, and a rule whose
 * `choose` names an option nobody offered never matches — a false match here
 * would answer a question nobody reviewed, so every miss is the cheap
 * direction.
 *
 * It lives in policy.js so that classify.js can use it without a cycle.
 *
 * @param {ReadonlyArray<{decisionClass?:string, choose?:string, contains?:string}>} rules
 * @param {{decisionClass?:string, question?:object, labels?:string[]}} input
 * @returns {object|null} the matching rule, or null.
 */
export function matchAllowRuleRules(rules, { decisionClass, question, labels } = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const offered = (Array.isArray(labels) ? labels : labelsOf(question)).filter((label) => typeof label === 'string')
  if (offered.length === 0) return null
  const wanted = typeof decisionClass === 'string' ? decisionClass : ''
  const text = textOf(question)
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    const ruleClass = typeof rule.decisionClass === 'string' ? rule.decisionClass.trim() : ''
    if (!ruleClass || !DECISION_CLASS_IDS.includes(ruleClass)) continue
    if (ruleClass !== wanted) continue
    const choose = typeof rule.choose === 'string' ? rule.choose.trim() : ''
    if (!choose) continue
    if (!offered.includes(choose)) continue
    const contains = typeof rule.contains === 'string' ? rule.contains : ''
    if (contains !== '' && !text.includes(contains)) continue
    return rule
  }
  return null
}
