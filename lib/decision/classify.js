/**
 * Deterministic System-0 classifier — the cheap, explainable, **model-free**
 * first stage of the decision layer.
 *
 * It answers two questions about a pending human question:
 *  1. which decision class is this? (drives `resolveMode`)
 *  2. which taxonomy level is it? (`C0_COMPUTED` … `C3_COMPLEX`), which decides
 *     the confidence bar and whether a model may answer at all.
 *
 * It is deliberately conservative: **anything it cannot tell defaults to
 * complex**, because a wrong `trivial` is a decision nobody reviewed. Every
 * rule here can only ever make the answer *less* automated.
 *
 * @module dsh-aidlc/decision/classify
 */
import {
  DECISION_CLASS_IDS,
  DECISION_LEVELS,
  LEVEL_TO_COMPLEXITY,
  applyClassMinLevel,
  classDefinition,
  isNeverAuto,
  isReversible,
  matchAllowRuleRules,
  minLevelOf,
  normalizeDecisionConfig,
  reconcileLevel,
  reconcileLevels,
} from './policy.js'

// The reconcile primitives live in policy.js (they need the tier tables, and
// `applyClassMinLevel` needs them without a cycle). Re-exported here because
// this is where callers and the verifier have always imported them from.
export { reconcileLevel, reconcileLevels }

/** Complexity ranks, worst last. */
const RANK = { trivial: 0, simple: 1, complex: 2 }

/** Taxonomy ranks, least automated last. */
const LEVEL_RANK = { C0_COMPUTED: 0, C1_TRIVIAL: 1, C2_SIMPLE: 2, C3_COMPLEX: 3 }

/**
 * Wording that marks a decision as carrying irreversible or out-of-band
 * consequences. Matched against the question text only; a hit can only ever
 * make the classifier MORE conservative.
 */
const RISK_PATTERN = /\b(delete|deleting|remove|removing|drop|dropping|destroy|purge|wipe|truncate|overwrite|force|irreversible|rollback|migrat\w*|prod|production|deploy|release|publish|push|secret|credential|password|token|api[-_ ]?key|billing|payment|invoice|contract|legal|compliance|security|schema[-_ ]?change)\b/i

/**
 * Class aliases a caller may tag a question with. Only aliases that point at a
 * *narrower or safer* class are allowed: `plan-review` is a human gate, so it
 * maps to the never-auto `gate.approval`, not to `plan.confirmation`.
 */
const CLASS_ALIASES = new Map([
  ['plan-review', 'gate.approval'],
  ['plan_review', 'gate.approval'],
  ['gate', 'gate.approval'],
  ['gate1', 'gate.approval'],
  ['gate2', 'gate.approval'],
  ['gate-approval', 'gate.approval'],
  ['unlock-tests', 'test.unlock'],
  ['test-unlock', 'test.unlock'],
  ['tdd-unlock', 'test.unlock'],
  ['unlock', 'test.unlock'],
  ['baseline', 'test.baseline'],
  ['test-baseline', 'test.baseline'],
  ['security', 'security.exception'],
  ['credentials', 'security.exception'],
  ['secrets', 'security.exception'],
  ['deploy', 'irreversible.operation'],
  ['publish', 'irreversible.operation'],
  ['migration', 'irreversible.operation'],
  ['policy', 'policy.change'],
  ['threshold', 'policy.change'],
  ['untrusted', 'untrusted.authorization'],
  ['design', 'design.choice'],
  ['architecture', 'design.choice'],
  ['scope', 'scope.expansion'],
  ['ordering', 'unit.ordering'],
  ['sequence', 'unit.ordering'],
  ['plan', 'plan.confirmation'],
  ['tweak', 'artifact.tweak'],
  ['typo', 'artifact.tweak'],
  ['generic', 'generic.question'],
])

/**
 * Ordered keyword rules used only when the caller did not tag the question.
 * Order is load-bearing, in two directions: the never-auto classes are tested
 * first, so "approve the plan" can never be inferred as `plan.confirmation`,
 * and a false hit on a never-auto class only ever costs one human answer.
 *
 * @type {ReadonlyArray<{id:string, re:RegExp, why:string}>}
 */
const KEYWORD_RULES = Object.freeze([
  // --- never-auto first: a false hit here is free, a miss is not.
  { id: 'test.baseline', re: /\bbaseline\b|\baccept\s+(the\s+)?new\s+failures\b|\bregression\s+baseline\b|\bre-?record\s+(the\s+)?(test\s+)?baseline\b/i, why: 'wording is about the test baseline' },
  { id: 'security.exception', re: /\bcredential\w*\b|\bsecrets?\b|\btokens?\b|\bapi[-_ ]?keys?\b|\bpasswords?\b|\.env\b|\bprivate\s+keys?\b|\bbypass\b|\bskip\s+(the\s+)?(guard|check|hook)\b|\bdisable\s+(the\s+)?(guard|sandbox|check|hook)\b|--force\b|\bdanger-full-access\b|\bsandbox\s+(mode|permission)/i, why: 'wording touches credentials, secrets or a guard' },
  { id: 'irreversible.operation', re: /\bforce[-\s]?push\b|\bpush\s+--force\b|\bdeploy\w*\b|\bpublish\w*\b|\bnpm\s+publish\b|\bmigrat\w+\b|\bdrop\s+(table|column|database)\b|\bdelete\s+(the\s+)?(branch|tag|release|artifact|repository)\b|\brm\s+-rf\b|\bwipe\w*\b|\bdestroy\w*\b|\bexternal\s+writes?\b/i, why: 'wording names an irreversible operation' },
  { id: 'policy.change', re: /\bnever[-_ ]?auto\b|\bdecision\s+(class|policy|threshold)\b|\bconfidence\s+threshold\b|\bdecision[-_ ]?model\s+(policy|config)/i, why: 'wording is about the decision policy itself' },
  { id: 'untrusted.authorization', re: /\buntrusted\b|\bexternal\s+(text|content|input)\b|\btool\s+output\b|\bweb\s*page\b|\bissue\s+body\b|\bemail\s+body\b/i, why: 'wording points at text authored outside the repository' },
  { id: 'test.unlock', re: /\b(unlock|release|disable)\b[^.]{0,40}\b(test|tests|tdd|lock)\b|\btdd\s+lock\b|\btest\s+lock\b/i, why: 'wording names the test/TDD lock' },
  { id: 'gate.approval', re: /\bgate\s*[12]?\b|\bapprove\s+(the\s+)?(gate|plan)\b|\bgate\s+approval\b|\bsign[-\s]?off\b/i, why: 'wording names a human gate' },
  // --- ordinary classes.
  { id: 'scope.expansion', re: /\bscope\b|\bout[-\s]of[-\s]scope\b|\bnew\s+(feature|requirement|unit|module)\b/i, why: 'wording is about scope' },
  { id: 'design.choice', re: /\bdesign\b|\barchitect\w*\b|\bapproach\b|\btech\w*\s+stack\b|\btrade[-\s]?off\b|\bschema\b|\bapi\s+shape\b/i, why: 'wording is about design' },
  { id: 'plan.confirmation', re: /\bplan\b|\bproceed\b|\bconfirm\b|\bgo\s+ahead\b/i, why: 'wording is about confirming a plan' },
  { id: 'unit.ordering', re: /\border(ing)?\b|\bsequence\b|\bwhich\s+(unit|task|step)\b|\bfirst\b/i, why: 'wording is about ordering' },
  { id: 'artifact.tweak', re: /\btypo\b|\bwording\b|\breword\b|\bcomment\b|\bformat(ting)?\b|\brename\b|\bcapitali[sz]/i, why: 'wording is about a cosmetic artifact edit' },
])

/**
 * @typedef {object} ClassifyContext
 * @property {string} [decisionClass] caller-supplied class — authoritative when known.
 * @property {'human'|'model'|'skill'|'command'|string} [decisionClassFrom] who assigned the class; `'model'` forces C3.
 * @property {boolean} [onGate] the question sits on a human gate.
 * @property {boolean} [allOptionsReversible] caller's own reversibility verdict.
 * @property {number} [hiddenJudgments] how many unstated judgments the decision hides.
 * @property {boolean} [externalText] the decision's state carries text authored outside the repo.
 * @property {string[]} [affectedPaths] paths the decision would touch.
 * @property {string} [root] workspace root (recorded, never trusted for safety).
 * @property {unknown} [config] resolved plugin config or decision sub-config.
 */

/**
 * @typedef {object} Classification
 * @property {string} decisionClass
 * @property {'trivial'|'simple'|'complex'} complexity frozen vocabulary, derived from `level`.
 * @property {'C0_COMPUTED'|'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'} level
 * @property {number} confidence classifier's own confidence in this answer (0..1) — NOT a model confidence.
 * @property {string[]} reasons the signals that drove the answer, for the auditor.
 * @property {{resolver:'allow-rule', rule:object}|null} c0 the deterministic resolver, when one applies.
 * @property {string[]} promotions fail-closed promotions applied after the first answer.
 */

/** Every non-empty option label offered by a question, in order. */
export function offeredLabels(question) {
  const options = Array.isArray(question?.options) ? question.options : []
  return options
    .map((option) => (option && typeof option.label === 'string' ? option.label : null))
    .filter((label) => typeof label === 'string' && label.trim() !== '')
}

/** The question text the classifier reads: header + question + detail. */
export function questionText(question) {
  return [question?.header, question?.question, question?.detail]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n')
}

/**
 * Classify one pending question.
 *
 * @param {{id?:string, question?:string, header?:string, detail?:string, options?:Array<{label?:string, description?:string, reversible?:boolean}>, multiSelect?:boolean, intent?:unknown}} question
 * @param {ClassifyContext} [context]
 * @returns {Classification}
 */
export function classify(question, context = {}) {
  const q = question && typeof question === 'object' ? question : {}
  const ctx = context && typeof context === 'object' ? context : {}
  const cfg = normalizeDecisionConfig(ctx.config)
  /** @type {string[]} */
  const reasons = []
  /** @type {string[]} */
  const promotions = []

  const labels = offeredLabels(q)
  const text = questionText(q)
  const lower = text.toLowerCase()

  const tagged = taggedClass(q, ctx, reasons)
  const keyword = tagged ? null : keywordClass(lower, reasons)
  const decisionClass = tagged?.id ?? keyword?.id ?? 'generic.question'

  const reversible = allOptionsReversible(q, decisionClass, ctx)
  const onGate = ctx.onGate === true || q.onGate === true
  let complexity = /** @type {'trivial'|'simple'|'complex'} */ ('trivial')
  const downgrade = (to, why) => {
    if (RANK[to] > RANK[complexity]) {
      complexity = to
      reasons.push(why)
    }
  }

  // --- shape: every signal can only ever make the answer less automated.
  if (labels.length === 0) downgrade('complex', 'no options were offered, so no model choice could name an answer')
  else if (labels.length > 4) downgrade('complex', `${labels.length} options were offered (>4)`)
  else if (labels.length > 2) downgrade('simple', `${labels.length} options were offered`)

  if (q.multiSelect === true) downgrade('complex', 'multi-select question: one choice cannot stand in for a set of answers')
  if (isNeverAuto(decisionClass)) downgrade('complex', `${decisionClass} can never be automated`)
  if (onGate) downgrade('complex', 'the question sits on a human gate')
  if (!reversible) downgrade('complex', 'at least one option is not reversible')
  if (RISK_PATTERN.test(text)) downgrade('complex', 'the wording carries irreversible or out-of-band consequences')
  if (text.length > 800) downgrade('complex', 'question text is longer than 800 characters')
  else if (text.length > 280) downgrade('simple', 'question text is longer than 280 characters')
  const paths = Array.isArray(ctx.affectedPaths) ? ctx.affectedPaths : []
  if (paths.length > 2) downgrade('complex', `${paths.length} affected paths (>2)`)
  else if (paths.length > 0) downgrade('simple', 'the decision names affected paths')
  if (keyword && complexity === 'trivial') downgrade('simple', 'the class was inferred from wording rather than declared')

  // --- level: start from the shape, then claim C0 only with a real resolver.
  /** @type {'C0_COMPUTED'|'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'} */
  let level = complexity === 'trivial' ? 'C1_TRIVIAL' : complexity === 'simple' ? 'C2_SIMPLE' : 'C3_COMPLEX'
  // `level` and `complexity` are two spellings of ONE answer, so every promotion
  // moves both. The exit reconciliation below re-derives them from a single tier
  // as well, which is what makes agreement an invariant of the function rather
  // than five separate fixes: a caller that branches on `complexity` (the live
  // wiring does) must never miss a promotion decided here.
  const raise = (to, why) => {
    if (LEVEL_RANK[to] > LEVEL_RANK[level]) {
      level = to
      complexity = LEVEL_TO_COMPLEXITY[to]
      promotions.push(why)
      reasons.push(why)
    }
  }

  const rules = cfg.classify.allowRules
  const hasRuleForClass = rules.some((rule) => rule && typeof rule === 'object' && rule.decisionClass === decisionClass)
  const c0Rule = complexity === 'trivial' && reversible && cfg.classify.deterministicTrivial
    ? matchAllowRuleRules(rules, { decisionClass, question: q, labels })
    : null
  if (c0Rule) {
    level = 'C0_COMPUTED'
    reasons.push('C0: a deterministic allow-rule can answer this without a model or a human')
  } else if (complexity === 'trivial' && hasRuleForClass) {
    // The vendor-blind spot the researcher named: a C0 resolver that hits an
    // unknown (an option nobody offered, a `contains` miss) must promote to C2,
    // never silently settle at C1.
    raise('C2_SIMPLE', 'the deterministic resolver for this class did not match (unknown option or `contains` miss): promoted to C2')
  }

  // --- fail-closed promotions the researcher supplied, verbatim in effect.
  if (!tagged && !keyword) raise('C3_COMPLEX', 'no decision class could be determined: promoted to C3')
  if (ctx.decisionClassFrom === 'model' || q.classifiedBy === 'model') {
    raise('C3_COMPLEX', 'the class was assigned by a model, and class assignment is itself C3')
  }
  const hidden = Number(ctx.hiddenJudgments)
  if (Number.isFinite(hidden) && hidden > 3) raise('C3_COMPLEX', `${hidden} hidden judgments (>3): decompose the question instead of raising the threshold`)
  if (ctx.externalText === true || q.externalText === true) {
    raise('C3_COMPLEX', 'the decision state carries text authored outside the repository: promoted to C3')
  }
  if (labels.length === 0 && !tagged) raise('C3_COMPLEX', 'nothing to classify on')

  // --- the class's own band floor (the anti-inversion rule). A *declared* class
  // skips the "inferred from wording ⇒ simple" downgrade above, so without this
  // a tagged question would land one band BELOW the same content untagged — the
  // tag would be a discount, on exactly the classes whose wrong answers are
  // expensive. A floor can only raise; `C0_COMPUTED` passes through because it is
  // not a confidence band at all (see `applyClassMinLevel`).
  const classFloor = minLevelOf(decisionClass, cfg)
  const flooredLevel = applyClassMinLevel(decisionClass, level, cfg)
  if (flooredLevel !== level && flooredLevel !== undefined && flooredLevel !== null) {
    const why = `class ${decisionClass} sets a minimum band of ${classFloor}: raised from ${level}`
    level = /** @type {typeof level} */ (flooredLevel)
    promotions.push(why)
    reasons.push(why)
  }

  // --- the D2 invariant, at the single exit point: `level` and `complexity`
  // are two spellings of one answer and are re-derived from one tier here, so
  // no promotion above can ever update one without the other.
  const reconciled = reconcileLevel(level, complexity)
  level = reconciled.level
  complexity = reconciled.complexity

  let confidence = tagged ? 0.9 : keyword ? 0.6 : 0.35
  if (labels.length >= 2 && labels.length <= 4) confidence += 0.05
  if (RISK_PATTERN.test(text)) confidence += 0.05
  confidence = Math.min(1, Math.max(0.1, Math.round(confidence * 100) / 100))

  if (tagged) reasons.unshift(`class ${decisionClass} declared by ${tagged.why}`)
  else if (keyword) reasons.unshift(`class ${decisionClass} inferred: ${keyword.why}`)

  reasons.push(`complexity ${complexity} / level ${level} (options=${labels.length}, reversible=${reversible}${onGate ? ', on-gate' : ''})`)

  return {
    decisionClass,
    complexity,
    level,
    confidence,
    reasons,
    c0: c0Rule ? { resolver: 'allow-rule', rule: c0Rule } : null,
    promotions,
  }
}

/**
 * A class the caller declared (or aliased), or null.
 *
 * @returns {{id:string, why:string}|null}
 */
function taggedClass(q, ctx, reasons) {
  const declared = typeof ctx.decisionClass === 'string' && ctx.decisionClass.trim() ? ctx.decisionClass.trim() : ''
  if (declared) {
    if (DECISION_CLASS_IDS.includes(declared)) return { id: declared, why: 'the caller' }
    const aliased = CLASS_ALIASES.get(declared.toLowerCase())
    if (aliased) return { id: aliased, why: `alias ${JSON.stringify(declared)}` }
    reasons.push(`ignored unknown decisionClass ${JSON.stringify(declared)}: an unknown class is never trusted`)
  }

  const intent = q.intent
  if (typeof intent === 'string' && intent.trim()) {
    const raw = intent.trim()
    if (DECISION_CLASS_IDS.includes(raw)) return { id: raw, why: 'the question intent tag' }
    const aliased = CLASS_ALIASES.get(raw.toLowerCase())
    if (aliased) return { id: aliased, why: `intent alias ${JSON.stringify(raw)}` }
    reasons.push(`ignored unknown intent tag ${JSON.stringify(raw)}`)
  }
  if (intent && typeof intent === 'object' && typeof /** @type {{kind?:unknown}} */ (intent).kind === 'string') {
    const kind = /** @type {{kind:string}} */ (intent).kind
    // The harness's plan-review intent is the plan-approval fast path: it is a
    // human gate, so it resolves to the never-auto class, not to
    // plan.confirmation. A plan a model approved is not a plan a human approved.
    const aliased = CLASS_ALIASES.get(kind.toLowerCase())
    if (aliased) return { id: aliased, why: `harness intent kind ${JSON.stringify(kind)}` }
  }
  return null
}

/** @returns {{id:string, why:string}|null} */
function keywordClass(lower, reasons) {
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(lower)) {
      if (rule.id === 'artifact.tweak' && (/\bdesign\b|\barchitect\w*\b|\bscope\b|\bgate\b|\bsecurity\b|\bdelete\b/i.test(lower))) {
        reasons.push(`cosmetic wording found (${rule.why}) but a heavier topic is also named: not treated as ${rule.id}`)
        continue
      }
      return { id: rule.id, why: rule.why }
    }
  }
  return null
}

/**
 * Whether every offered option is reversible.
 *
 * An explicit per-option `reversible` declaration wins when all options carry
 * one; otherwise the class definition answers. Unknown shapes are **not**
 * reversible — the fail-closed direction.
 *
 * @param {object} question
 * @param {string} decisionClass
 * @param {ClassifyContext} [context]
 * @returns {boolean}
 */
export function allOptionsReversible(question, decisionClass, context = {}) {
  const options = (Array.isArray(question?.options) ? question.options : []).filter((o) => o && typeof o.label === 'string')
  if (options.length === 0) return false
  // The caller's explicit veto is the SAFE direction and outranks request data:
  // an option's `reversible: true` is a claim the request (or the model that
  // wrote it) can assert, and it must never be able to upgrade a caller that
  // already said no.
  if (context.allOptionsReversible === false) return false
  if (options.some((o) => o.reversible === false)) return false
  // An irreversible class is never upgraded by request data or caller optimism.
  return isReversible(decisionClass)
}

/**
 * Inexpressive allow-rule matching, copied from the shipping guardian's
 * `matchAllowRule`: exact class, literal option label, optional literal
 * substring. A false match here answers a question nobody reviewed, so every
 * part must be literal and an unknown or empty `decisionClass` is never a
 * wildcard.
 *
 * @param {ReadonlyArray<{decisionClass?:string, choose?:string, contains?:string}>} rules
 * @param {{decisionClass?:string, question?:object, labels?:string[]}} input
 * @returns {object|null} the matching rule, or null.
 */
export function matchAllowRule(rules, { decisionClass, question, labels } = {}) {
  return matchAllowRuleRules(rules, { decisionClass, question, labels })
}

/**
 * Whether a class definition exists for this id (used by the surfacer).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isKnownClass(id) {
  return classDefinition(id) !== null
}

/** All four taxonomy levels, re-exported for callers that validate an input. */
export { DECISION_LEVELS }
