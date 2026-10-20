/**
 * The decision arbiter — the one place where a decision is actually made.
 *
 * It never throws, never touches a global, and never fabricates an answer for a
 * settled harness call. It serves exactly two legitimate substitution points:
 *
 *  - **Point A — pre-empt** (`prefer:'model-first'`): a question the human
 *    should never have seen. The model answers *before* anyone is asked; the
 *    arbiter never starts a human ask, and returns `answer:null` when it cannot
 *    resolve the decision itself, so the caller delegates to the human.
 *  - **Point B — timeout fallback** (`prefer:'timeout-fallback'`): the human has
 *    ALREADY timed out (`ASK_TIMED_OUT` / `{pending:true}`). The harness never
 *    fabricates a result for the finished call — and neither does this module.
 *    It consults the model once, reports whether the verdict cleared every gate
 *    (`applicable`), and returns **no answer at all**. The lifecycle layer
 *    records the decision and unblocks the *pipeline*, not the tool call; if the
 *    human answers later, the human wins and the record is amended with
 *    `superseded_by:'human'`.
 *
 * There is deliberately no "race the human" path: it would answer a question
 * that is still live, and the late answer would arrive twice.
 *
 * Fail-closed at every step: a throw, a timeout, unparseable JSON, an option
 * nobody offered, a self-doubting transport or a below-bar probability yields
 * `{source:'none', substituted:false, answer:null}` plus exactly one audit
 * record saying why.
 *
 * @module dsh-aidlc/decision/arbiter
 */
import { createHash } from 'node:crypto'
import { allOptionsReversible, offeredLabels, questionText, reconcileLevels } from './classify.js'
import { DECISION_CLASS_IDS, LEVEL_TO_COMPLEXITY, applyClassMinLevel, gateForLevel, isReversible, matchAllowRuleRules, minLevelOf, normalizeDecisionConfig, rawConfiguredMode, resolveMode } from './policy.js'
import { buildDecisionPrompt } from './reviewer.js'

/** The complexity vocabulary the frozen interface accepts. */
const COMPLEXITY_VALUES = new Set(['trivial', 'simple', 'complex'])

/** Labels that read as "let it through". A critical-risk answer naming one is never applied. */
const PERMISSIVE_LABEL = /^\s*(allow|allowed|approve|approved|accept|accepted|yes|y|ok|okay|proceed|continue|confirm|confirmed|go\s+ahead|ship\s+it|do\s+it|enable|enabled|unlock|pass)\b/i

/**
 * How far above the gate a verdict may sit and still be re-checked with the
 * option order reversed. Option-order bias is real for Jev-class models, so a
 * verdict that only just clears the bar has to survive the reversal.
 */
const RECHECK_BAND = 0.1

/** A short, safe error message from an unknown thrown value. */
function messageOf(error) {
  const message = error && typeof error === 'object' && 'message' in error ? String(/** @type {{message:unknown}} */ (error).message) : String(error)
  return message.slice(0, 300)
}

/** A clock read that can never break the arbiter. */
function safeNow(nowFn) {
  try {
    const value = nowFn()
    return Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}

/** A short, stable digest of the state a decision was made on. */
function digestOf(value) {
  try {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex').slice(0, 32)
  } catch {
    return null
  }
}

/** One outcome, fail-closed by default. */
function outcome(fields = {}) {
  return {
    answer: null,
    source: 'none',
    substituted: false,
    advisory: false,
    applicable: false,
    timedOut: false,
    confidence: null,
    verdict: null,
    code: 'none',
    reason: '',
    ...fields,
  }
}

/**
 * The harness-shaped answer for one decided question. Only Point A ever
 * produces one.
 *
 * @param {object} primary
 * @param {string} choice
 * @returns {{answers: Array<{id?:string, selected:string[]}>}}
 */
export function shapedAnswer(primary, choice) {
  return { answers: [{ ...(typeof primary?.id === 'string' ? { id: primary.id } : {}), selected: [choice] }] }
}

/**
 * The questions this invocation is deciding. The wiring layer hands both the raw
 * event (`{questions:[...]}`) and the array; either shape works, and a bare
 * single-question request works too.
 *
 * @param {object} options
 * @returns {{batch:object[], primary:object, labels:string[]}}
 */
export function questionBatch(options) {
  const fromOptions = Array.isArray(options?.questions) ? options.questions : null
  const fromRequest = Array.isArray(options?.request?.questions) ? options.request.questions : null
  const batch = (fromOptions ?? fromRequest ?? []).filter((q) => q && typeof q === 'object')
  if (batch.length > 0) {
    const primary = batch.find((q) => Array.isArray(q.options) && q.options.length > 0) ?? batch[0]
    return { batch, primary, labels: offeredLabels(primary) }
  }
  const single = options?.request && typeof options.request === 'object' ? options.request : {}
  return { batch: [single], primary: single, labels: offeredLabels(single) }
}

/**
 * Bound one async operation by a deadline without leaking an unhandled
 * rejection: the operation's own settle handlers are always attached.
 *
 * @template T
 * @returns {Promise<{timedOut:true}|{value:T}|{error:unknown}>}
 */
async function bounded(run, ms, setTimer, clearTimer) {
  if (!(Number.isFinite(ms) && ms > 0)) {
    try {
      return { value: await run() }
    } catch (error) {
      return { error }
    }
  }
  return await new Promise((resolve) => {
    let done = false
    const timer = setTimer(() => {
      if (!done) {
        done = true
        resolve({ timedOut: true })
      }
    }, Math.floor(ms))
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          if (!done) {
            done = true
            clearTimer(timer)
            resolve({ value })
          }
        },
        (error) => {
          if (!done) {
            done = true
            clearTimer(timer)
            resolve({ error })
          }
        },
      )
  })
}

/**
 * Validate a raw `{choice, confidence, probabilities, risk, reason}` answer.
 * Trusts nothing: the choice must name an offered label, a present confidence
 * must be a finite probability, a present risk must be one of the four values.
 * Probabilities are kept **only for offered labels** — an inflated number for
 * an option nobody offered must never raise the gate value.
 *
 * @param {unknown} raw
 * @param {string[]} labels offered option labels, in presentation order.
 * @returns {{ok:true, choice:string, confidence:number|null, probabilities:Record<string,number>|null, risk:string, reason:string, backend:string|null, lowConfidence:boolean}|{ok:false, code:string, reason:string}}
 */
export function validateModelAnswer(raw, labels) {
  if (raw === null || raw === undefined) return { ok: false, code: 'model-empty', reason: 'the decision model returned nothing usable' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'model-malformed', reason: 'the decision model returned a non-object answer' }
  const value = /** @type {Record<string, any>} */ (raw)
  const choice = typeof value.choice === 'string' ? value.choice.trim() : ''
  if (!choice) return { ok: false, code: 'model-empty-choice', reason: 'the decision model named no choice' }
  if (!labels.includes(choice)) {
    return {
      ok: false,
      code: 'model-unknown-option',
      reason: `the decision model chose ${JSON.stringify(choice)}, which is not one of the offered options; discarded`,
    }
  }
  let confidence = null
  if (value.confidence !== undefined && value.confidence !== null) {
    if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
      return { ok: false, code: 'model-bad-confidence', reason: 'the decision model reported an unusable confidence: ' + JSON.stringify(value.confidence) }
    }
    confidence = value.confidence
  }
  /** @type {Record<string,number>|null} */
  let probabilities = null
  if (value.probabilities && typeof value.probabilities === 'object' && !Array.isArray(value.probabilities)) {
    /** @type {Record<string,number>} */
    const kept = {}
    for (const [label, probability] of Object.entries(/** @type {Record<string,unknown>} */ (value.probabilities))) {
      if (!labels.includes(label)) continue
      if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) continue
      kept[label] = probability
    }
    if (Object.keys(kept).length > 0) probabilities = kept
  }
  let risk = 'unknown'
  if (value.risk !== undefined && value.risk !== null) {
    const rawRisk = typeof value.risk === 'string' ? value.risk.trim().toLowerCase() : ''
    // `'unknown'` is the documented "the model did not say" sentinel every
    // transport fills in for the OPTIONAL `risk` field, so it must be readable
    // here: rejecting our own sentinel made a legal answer shape unusable (D3).
    // It can only ever *permit* less than the four real values — risk gates
    // substitution at `high` and `critical` only.
    if (rawRisk !== 'unknown' && rawRisk !== 'low' && rawRisk !== 'medium' && rawRisk !== 'high' && rawRisk !== 'critical') {
      return { ok: false, code: 'model-bad-risk', reason: 'the decision model reported an unusable risk: ' + JSON.stringify(value.risk) }
    }
    risk = rawRisk
  }
  return {
    ok: true,
    choice,
    confidence,
    probabilities,
    risk,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 600) : '',
    backend: typeof value.backend === 'string' && value.backend ? value.backend : null,
    lowConfidence: value.lowConfidence === true || value.low_confidence === true,
  }
}

/**
 * The gate value: the top probability of the models's chosen option when the
 * transport reports probabilities, otherwise the self-reported confidence.
 *
 * TypeSafe's Choice `confidence` is `(p_max − 1/n)/(1 − 1/n)`, which MOVES when
 * an option is added, so a fixed threshold over it silently changes meaning.
 * The top probability does not. `confidence` and `p_max_over_second` are
 * recorded alongside for the audit.
 *
 * @param {{confidence:number|null, probabilities:Record<string,number>|null}} verdict
 * @returns {{gateValue:number|null, pMax:number|null, pMaxOverSecond:number|null, derivedConfidence:number|null, probabilities:Record<string,number>|null}}
 */
export function probabilityStats(verdict) {
  const probabilities = verdict.probabilities ?? null
  if (!probabilities) {
    return { gateValue: verdict.confidence ?? null, pMax: null, pMaxOverSecond: null, derivedConfidence: null, probabilities: null }
  }
  const values = Object.values(probabilities).slice().sort((a, b) => b - a)
  const pMax = values[0]
  const second = values.length > 1 ? values[1] : 0
  const n = Object.keys(probabilities).length
  const derivedConfidence = n > 1 ? (pMax - 1 / n) / (1 - 1 / n) : null
  return { gateValue: pMax, pMax, pMaxOverSecond: pMax - second, derivedConfidence, probabilities }
}

/**
 * Race a human answer against a deadline and a decision model.
 * Never throws. Always returns an audit record alongside the answer.
 *
 * @param {object} input
 * @param {object} input.request raw harness request (`{questions:[...], agent?, signal?}`) or one question.
 * @param {object[]} [input.questions] the same questions array, for convenience.
 * @param {string} [input.decisionClass] from `classify()` or the caller.
 * @param {'trivial'|'simple'|'complex'} [input.complexity] frozen vocabulary.
 * @param {'C0_COMPUTED'|'C1_TRIVIAL'|'C2_SIMPLE'|'C3_COMPLEX'} [input.level] taxonomy level (falls back to `classification.level`).
 * @param {object} [input.classification] the full `classify()` result, echoed into the audit record.
 * @param {object} input.deps `{consultModel, record, now, consultModelFallback?, setTimer?, clearTimer?}`; `askHuman` is accepted but never called.
 * @param {unknown} [input.config] resolved decision config (or the whole plugin config).
 * @param {'model-first'|'timeout-fallback'} [input.prefer] Point A or Point B. Derived from the mode when absent (a `triage` class consults first; anything else records). Complexity no longer changes the lane: it raises the BAR.
 * @param {boolean} [input.humanTimedOut] Point B only: the human's ask already timed out.
 * @param {object} [input.prompt] prompt handed to `consultModel`; built from the request when absent.
 * @param {string} [input.provider] session-transport provider, forwarded into the prompt.
 * @param {string} [input.model] session-transport model, forwarded into the prompt.
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<object>} `{answer, source, substituted, advisory, applicable, timedOut, confidence, verdict, record, mode, decisionClass, complexity, level, prefer, code, reason, vetoUntil, escalateAt}`
 */
export async function arbitrate(input = {}) {
  const options = input && typeof input === 'object' ? input : {}
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {}
  const cfg = normalizeDecisionConfig(options.config)
  const asked = questionBatch(options)
  const request = options.request && typeof options.request === 'object' ? options.request : asked.primary
  const signal = options.signal ?? (request && typeof request === 'object' ? request.signal : undefined)

  const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const recordFn = typeof deps.record === 'function' ? deps.record : null
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout
  const startedAt = safeNow(nowFn)

  const rawClass = typeof options.decisionClass === 'string' ? options.decisionClass.trim() : ''
  const classKnown = rawClass !== '' && DECISION_CLASS_IDS.includes(rawClass)
  const classUnknown = rawClass !== '' && !classKnown
  const declaredClass = classKnown ? rawClass : 'generic.question'
  // The RAW value goes to the reconciler, not a filter: `COMPLEXITY_VALUES.has()`
  // would silently DROP a string the caller did supply, and a spelling that is
  // neither honoured nor refused is the same defect class one level down. A
  // non-string or unrecognised value therefore reaches `reconcileLevels`, which
  // fails closed to C3. `declaredComplexity` exists only for the audit trail.
  const suppliedComplexity = options.complexity === undefined || options.complexity === null || options.complexity === ''
    ? undefined
    : options.complexity
  const declaredComplexity = suppliedComplexity === undefined
    ? null
    : typeof suppliedComplexity === 'string' ? suppliedComplexity : String(suppliedComplexity)
  /** Whether the caller's complexity spelling was one we know. Audit-only: an unrecognised one still fails closed to C3. */
  const complexityRecognised = typeof suppliedComplexity === 'string' && COMPLEXITY_VALUES.has(suppliedComplexity)
  // Every spelling of the level the caller supplied is RECONCILED, never chosen
  // by precedence. `options.level ?? classification.level ?? complexity` looked
  // reasonable and was a hole: a caller passing `level:'C1_TRIVIAL'` alongside
  // `complexity:'complex'` won the chain outright, so the band bar below was
  // computed from the cheaper spelling the caller had also contradicted — and a
  // contradictory payload is precisely a caller telling the arbiter that a hard
  // decision is an easy one. The highest tier any spelling names wins; an
  // unrecognised spelling fails closed to C3; nothing supplied at all stays
  // "unclassified" and is gated at the operator's floor.
  const reconciled = reconcileLevels(options.level, options.classification?.level, suppliedComplexity)
  const reconciledLevel = reconciled === null ? null : reconciled.level
  // The class's own band floor, applied here as well as in `classify()`. The two
  // layers are separately editable and the caller hands us a raw level, so the
  // floor has to hold on every path — not only on the path that went through the
  // classifier. A tag must never be a discount, whoever computed the band.
  const reducedLevel = applyClassMinLevel(declaredClass, reconciledLevel, cfg)
  const declaredLevel = reducedLevel === undefined ? reconciledLevel : reducedLevel
  // NOTE: `complexity` stays the question's SHAPE, not the floored band. The
  // floor raises the BAR; it must not disable the operator's deterministic
  // allow-rule, which is not a model judgement at all (the C0 tier test below is
  // about shape). The record reports the effective band from the level instead.
  const complexity = reconciled === null ? null : reconciled.complexity
  const classMinLevel = minLevelOf(declaredClass, cfg)
  // An explicitly named class we do not know is a typo or a newer taxonomy:
  // resolve it as-is so policy.js clamps it to `hold`. Only an ABSENT class
  // falls back to `generic.question`, and that assumption is audited.
  const mode = resolveMode({ decisionClass: classUnknown ? rawClass : declaredClass, config: cfg })
  /** The operator's own spelling of the mode (e.g. the `substitute` alias), for the audit. */
  const modeConfigured = rawConfiguredMode(options.config, declaredClass) ?? mode
  const labels = asked.labels
  const batchSize = asked.batch.length
  const modelTimeoutMs = typeof cfg.model?.timeoutMs === 'number' ? cfg.model.timeoutMs : 24_000

  // Point B whenever the human has already timed out, or whenever the decision
  // is one this lane cannot pre-empt. `triage` means "consult first", so its
  // default lane is Point A; a class that resolves to `hold`/`advisory` is never
  // pre-empted, so those default to Point B (where they merely record).
  const prefer = options.prefer === 'model-first' || options.prefer === 'timeout-fallback'
    ? options.prefer
    : options.prefer === 'human-first'
      ? 'timeout-fallback'
      : mode === 'triage'
        ? 'model-first'
        : 'timeout-fallback'
  const timedOut = typeof options.humanTimedOut === 'boolean' ? options.humanTimedOut : prefer === 'timeout-fallback'

  // Why a model answer may not be APPLIED (as opposed to not being asked for).
  const applyBlock = (() => {
    if (mode !== 'triage') return { code: 'advisory-only', reason: `mode is ${mode}: the verdict is recorded, the pipeline still blocks` }
    if (batchSize !== 1) return { code: 'batched-question', reason: `${batchSize} questions arrived together: one model choice cannot answer a batch` }
    if (labels.length === 0) return { code: 'no-options', reason: 'the question offered no options, so no model choice could name an answer' }
    if (asked.primary?.multiSelect === true) return { code: 'multi-select', reason: 'a multi-select question needs a set of answers, not one choice' }
    if (!isReversible(declaredClass)) return { code: 'irreversible-class', reason: `${declaredClass} is not reversible, so it cannot be auto-decided` }
    if (!(cfg.vetoWindowMs > 0)) return { code: 'no-veto-window', reason: 'triage is not offered without a veto window (decision.vetoWindowMs is 0)' }
    return null
  })()

  const threshold = cfg.confidenceThreshold
  const levelGate = gateForLevel(declaredLevel, threshold, cfg.levelFloors)

  const basePrompt = options.prompt ?? buildDecisionPrompt({
    request: asked.primary,
    decisionClass: declaredClass,
    complexity: complexity ?? 'complex',
    mode,
    labels,
    extraPolicy: typeof cfg.model?.extraPolicy === 'string' ? cfg.model.extraPolicy : '',
  })
  // The 'session' transport decides with the calling session's own model, whose
  // provider/model only the wiring layer knows. Forward them when it supplies
  // them; without them that transport fails closed, which is correct.
  //
  // Every prompt handed to a transport goes through this, INCLUDING the reversed
  // re-ask below: a rebuilt prompt that dropped these fields made the session
  // transport fail on the re-ask, which read as "the model disagreed with
  // itself" and silently refused to apply a verdict it had already accepted.
  const withWiringFields = (built) => (options.provider || options.model
    ? { ...built, ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}) }
    : built)
  const prompt = withWiringFields(basePrompt)

  /** Consult one transport, bounded by the model deadline. */
  async function consult(fn, overridePrompt) {
    if (typeof fn !== 'function') return { ok: false, code: 'no-model-source', reason: 'no decision-model transport was wired for this call' }
    if (signal?.aborted) return { ok: false, code: 'aborted', reason: 'the request was cancelled before the model was consulted' }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const onAbort = () => controller?.abort()
    if (signal) {
      if (signal.aborted) controller?.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const began = safeNow(nowFn)
    const result = await bounded(
      () => Promise.resolve(fn(overridePrompt ?? prompt, controller ? { signal: controller.signal } : {})),
      modelTimeoutMs,
      setTimer,
      clearTimer,
    )
    const latency = Math.max(0, Math.round(safeNow(nowFn) - began))
    if (signal) signal.removeEventListener('abort', onAbort)
    if (signal?.aborted) return { ok: false, code: 'aborted', reason: 'the request was cancelled while the model was deciding', latencyMs: latency }
    if (result && /** @type {any} */ (result).timedOut === true) {
      controller?.abort()
      return { ok: false, code: 'model-timeout', reason: `the decision model did not answer within ${modelTimeoutMs}ms`, latencyMs: latency }
    }
    if (result && 'error' in result) {
      return { ok: false, code: 'model-error', reason: 'the decision model failed: ' + messageOf(/** @type {any} */ (result).error), latencyMs: latency }
    }
    const validated = validateModelAnswer(/** @type {any} */ (result).value, labels)
    if (!validated.ok) return { ...validated, latencyMs: latency }
    return { ok: true, verdict: { ...validated, latencyMs: latency } }
  }

  /** The deterministic resolver (C0): no model, no human. */
  function c0RuleFor() {
    const fromClassification = options.classification?.c0?.rule
    if (fromClassification && typeof fromClassification === 'object'
      && typeof fromClassification.choose === 'string' && labels.includes(fromClassification.choose.trim())) {
      return fromClassification
    }
    return matchAllowRuleRules(cfg.classify.allowRules, { decisionClass: declaredClass, question: asked.primary, labels })
  }

  const deterministicEligible = mode === 'triage'
    && cfg.classify.deterministicTrivial
    && complexity === 'trivial'
    && batchSize === 1
    && asked.primary?.multiSelect !== true
    && (cfg.vetoWindowMs > 0)
    && allOptionsReversible(asked.primary, declaredClass, { allOptionsReversible: options.allOptionsReversible })
  const c0Rule = deterministicEligible ? c0RuleFor() : null
  const hasRuleForClass = cfg.classify.allowRules.some((rule) => rule && typeof rule === 'object' && rule.decisionClass === declaredClass)
  // A C0 resolver that hits an unknown promotes to C2 — never silently C1.
  const promotedFromC0 = c0Rule === null && (declaredLevel === 'C0_COMPUTED' || (deterministicEligible && hasRuleForClass))
  const effectiveLevel = promotedFromC0 ? 'C2_SIMPLE' : declaredLevel
  const gate = promotedFromC0 ? gateForLevel('C2_SIMPLE', threshold, cfg.levelFloors) : levelGate

  /**
   * Adjudicate a usable verdict: does it clear every gate?
   * Returns the pieces both lanes need; it applies nothing itself.
   *
   * Complexity is a BAR here, not a veto. The band's threshold comes from
   * `gateForLevel` (C0/C1 → the floor, C2 → 0.85, C3 → 0.95), so a C3 decision
   * at 0.96 is applied and one at 0.94 escalates carrying the recommendation.
   * The refusals that remain absolute are about AUTHORITY (`applyBlock`, the
   * mode clamp, the six never-auto classes in policy.js) and about risk
   * (`critical`), never about how hard the question looked.
   */
  function adjudicate(verdict) {
    const stats = probabilityStats(verdict)
    const value = stats.gateValue
    const detail = { ...stats, gate, threshold, level: effectiveLevel }
    if (applyBlock) return { applicable: false, code: applyBlock.code, reason: applyBlock.reason, detail, lowConfidence: verdict.lowConfidence }
    if (verdict.lowConfidence) {
      return { applicable: false, code: 'model-self-doubt', reason: 'the transport flagged its own answer as low confidence', detail, lowConfidence: true }
    }
    if (typeof value !== 'number') {
      return {
        applicable: false,
        code: 'missing-confidence',
        reason: `the transport reported no confidence and no probabilities, so it cannot clear the gate ${gate}`,
        detail,
        lowConfidence: true,
      }
    }
    // A high-risk verdict faces the strict bar whatever its level.
    const effectiveGate = verdict.risk === 'high' ? Math.max(gate, 0.85) : gate
    detail.gate = effectiveGate
    if (value < effectiveGate) {
      return {
        applicable: false,
        code: 'low-confidence',
        reason: `gate value ${round3(value)} is below the ${effectiveGate} bar for ${effectiveLevel ?? 'an unclassified decision'}`,
        detail,
        lowConfidence: true,
      }
    }
    if (verdict.risk === 'critical') {
      if (cfg.blockOnCriticalRisk) {
        return {
          applicable: false,
          code: 'critical-risk',
          reason: 'the model rated this critical, and critical decisions are never auto-applied (decision.blockOnCriticalRisk)',
          detail,
        }
      }
      if (PERMISSIVE_LABEL.test(verdict.choice)) {
        return {
          applicable: false,
          code: 'critical-allow',
          reason: `the model rated this critical AND chose ${JSON.stringify(verdict.choice)}; critical risk can never be allowed, whatever the config says`,
          detail,
        }
      }
    }
    return { applicable: true, code: 'applicable', reason: 'every gate passed', detail, lowConfidence: false }
  }

  /**
   * Re-ask with the option order reversed while the verdict sits inside the
   * uncertain band.
   *
   * The band is `[bar, min(1, bar + RECHECK_BAND))`. Two rules keep the
   * mitigation from firing where it is not needed:
   *
   *  - the upper edge is CAPPED at 1.0, because a probability cannot exceed it;
   *  - when `bar + RECHECK_BAND > 1` the band is DEGENERATE — every value that
   *    cleared the bar is inside it — so the re-ask is skipped. Without this a
   *    C3 verdict (bar 0.95) was re-asked *for certain*: two model calls for
   *    every applied C3, and a disagreement could downgrade a decision the model
   *    had actually made correctly into "the model doesn't know". The mitigation
   *    exists because a low-confidence verdict is suspect; at 0.95 the verdict is
   *    by definition not low-confidence, so it must not be subject to it.
   *
   * `status` makes "one call" and "two calls" explicit in the audit rather than
   * something a reader has to infer from the counts.
   */
  async function recheckReversed(verdict, adjudication) {
    if (!(cfg.classify.recheckReversed !== false)) return { attempted: false, agreed: null, status: 'skipped-disabled' }
    const value = adjudication.detail.gateValue
    const bar = adjudication.detail.gate
    const upper = Math.min(1, bar + RECHECK_BAND)
    if (bar + RECHECK_BAND > 1) return { attempted: false, agreed: null, status: 'skipped-band-capped' }
    if (typeof value !== 'number' || !(value < upper)) return { attempted: false, agreed: null, status: 'skipped-outside-band' }
    const reversedOptions = Array.isArray(asked.primary?.options) ? [...asked.primary.options].reverse() : []
    const reversedPrompt = withWiringFields(buildDecisionPrompt({
      request: { ...asked.primary, options: reversedOptions },
      decisionClass: declaredClass,
      complexity: complexity ?? 'complex',
      mode,
      labels: [...labels].reverse(),
      extraPolicy: typeof cfg.model?.extraPolicy === 'string' ? cfg.model.extraPolicy : '',
    }))
    const again = await consult(deps.consultModel, reversedPrompt)
    const agreed = again.ok === true && again.verdict.choice === verdict.choice
    return { attempted: true, agreed, verdict: again.ok ? again.verdict : null, failure: again.ok ? null : again.code, status: 'attempted' }
  }

  /**
   * Below-the-bar answers are not evidence for either outcome; `onLowConfidence`
   * decides what is recorded, never whether the pipeline unblocks.
   *
   * Every one of these paths ESCALATES, and every one carries the model's
   * recommendation: the record keeps `chosen`, `p_max` and the model's own
   * reasoning, so the human is handed a pre-digested question rather than a bare
   * one. That is the other half of "reduce unnecessary interruptions" — when a
   * human IS needed, their cost should be low.
   */
  async function lowConfidenceOutcome(verdict, adjudication, lane) {
    const policy = cfg.onLowConfidence
    const recommendation = verdict.reason ? ` The model recommended ${JSON.stringify(verdict.choice)} and said: ${verdict.reason}` : ` The model recommended ${JSON.stringify(verdict.choice)}.`
    const base = {
      advisory: true,
      applicable: false,
      timedOut,
      confidence: verdict.confidence,
      verdict,
      lowConfidence: true,
      code: adjudication.code,
      reason: adjudication.reason,
    }
    if (policy === 'advisory') {
      return outcome({ ...base, source: 'model', code: 'low-confidence-advisory', reason: `${adjudication.reason}.${recommendation} Recorded as an advisory and the pipeline keeps blocking (decision.onLowConfidence="advisory")` })
    }
    if (policy === 'defer-model') {
      const fallback = await consult(deps.consultModelFallback)
      if (fallback.ok) {
        return outcome({
          ...base,
          source: 'model',
          fallbackUsed: true,
          verdict: fallback.verdict,
          confidence: fallback.verdict.confidence,
          code: 'low-confidence-deferred',
          reason: `${adjudication.reason}.${recommendation} The fallback transport was asked once and its opinion (${JSON.stringify(fallback.verdict.choice)}) is recorded as an advisory only — applying it needs the primary transport to be confident (decision.onLowConfidence="defer-model")`,
        })
      }
      return outcome({
        ...base,
        source: 'none',
        fallbackUsed: true,
        code: 'low-confidence-deferred',
        reason: `${adjudication.reason}; the fallback transport produced nothing usable (${fallback.reason}), so the human decides`,
      })
    }
    return outcome({ ...base, source: 'none', code: adjudication.code, reason: `${adjudication.reason}.${recommendation} Escalating to the human (fail closed)` })
  }

  /** Turn a consult result into an outcome for one lane. */
  async function resolveVerdict(consulted, lane) {
    if (!consulted.ok) {
      return outcome({ code: consulted.code, reason: consulted.reason, timedOut, latencyMs: consulted.latencyMs ?? null })
    }
    const verdict = consulted.verdict
    const adjudication = adjudicate(verdict)

    if (!adjudication.applicable && adjudication.lowConfidence && !applyBlock) {
      return await lowConfidenceOutcome(verdict, adjudication, lane)
    }

    if (lane === 'model-first') {
      if (adjudication.applicable) {
        const recheck = await recheckReversed(verdict, adjudication)
        if (recheck.attempted && recheck.agreed !== true) {
          const refused = await lowConfidenceOutcome(verdict, {
            ...adjudication,
            code: 'option-order-disagreement',
            reason: `the verdict landed inside the uncertain band and the reversed option order produced ${recheck.agreed === false ? 'a different choice' : `no usable answer (${recheck.failure})`}`,
          }, lane)
          return { ...refused, recheck }
        }
        return outcome({
          answer: shapedAnswer(asked.primary, verdict.choice),
          source: 'model',
          substituted: true,
          applicable: true,
          timedOut,
          confidence: verdict.confidence,
          verdict,
          code: 'substituted',
          reason: verdict.reason || 'the decision model answered',
          adjudication,
          recheck,
        })
      }
      return outcome({
        source: 'model',
        advisory: true,
        applicable: false,
        timedOut,
        confidence: verdict.confidence,
        verdict,
        code: adjudication.code,
        reason: `${verdict.reason || 'the decision model answered'} — recorded, not applied: ${adjudication.reason}`,
        adjudication,
      })
    }

    // Point B: the verdict never becomes an answer for the settled call.
    return outcome({
      source: 'model',
      advisory: true,
      applicable: adjudication.applicable,
      timedOut,
      confidence: verdict.confidence,
      verdict,
      code: adjudication.applicable ? 'timeout-verdict' : adjudication.code,
      reason: adjudication.applicable
        ? `${verdict.reason || 'the decision model answered'} — applicable at the lifecycle level; no answer is fabricated for the settled call`
        : `${verdict.reason || 'the decision model answered'} — not applicable: ${adjudication.reason}`,
      adjudication,
    })
  }

  let decision
  try {
    if (signal?.aborted) {
      decision = outcome({ code: 'aborted', reason: 'the request was cancelled before any decision was made' })
    } else if (mode === 'hold') {
      decision = outcome({
        code: classUnknown ? 'unknown-class' : 'hold',
        reason: classUnknown
          ? `unknown decision class ${JSON.stringify(rawClass)}: treated as hold, so only the human answers (fail closed)`
          : `${declaredClass} resolves to hold: only the human may answer it, and the model is never consulted`,
      })
    } else if (labels.length === 0) {
      // Nothing a model could name, so nothing to send it: fail closed without
      // spending a call on a question that has no options.
      decision = outcome({ code: 'no-options', reason: 'the question offered no options, so no model choice could name an answer', timedOut })
    } else if (c0Rule) {
      const choice = String(c0Rule.choose).trim()
      decision = outcome({
        answer: prefer === 'model-first' ? shapedAnswer(asked.primary, choice) : null,
        source: 'deterministic',
        substituted: prefer === 'model-first',
        applicable: true,
        timedOut,
        confidence: 1,
        verdict: { choice, confidence: 1, probabilities: null, risk: 'low', reason: `deterministic allow-rule for ${declaredClass}`, backend: 'allow-rule', lowConfidence: false, latencyMs: 0 },
        code: 'deterministic-allow-rule',
        reason: `a deterministic allow-rule for ${declaredClass} chose ${JSON.stringify(choice)}; the model was never consulted`,
      })
    } else {
      const consulted = await consult(deps.consultModel)
      decision = await resolveVerdict(consulted, prefer)
    }
  } catch (error) {
    decision = outcome({ code: 'arbiter-error', reason: 'the arbiter hit an unexpected error and failed closed: ' + messageOf(error) })
  }

  return finish(decision, {
    asked, cfg, nowFn, recordFn, startedAt, declaredClass, classUnknown, rawClass, mode, prefer, complexity,
    level: effectiveLevel, declaredLevel: reconciledLevel, declaredComplexity, complexityRecognised, classMinLevel, modeConfigured, promotedFromC0, gate, labels, batchSize, options, prompt, timedOut,
  })
}

/** Round to three decimals for a reason string. */
function round3(value) {
  return Math.round(value * 1000) / 1000
}

/** Build the one audit record, deliver it once, and compose the public outcome. */
function finish(decision, context) {
  const {
    asked, cfg, nowFn, recordFn, startedAt, declaredClass, classUnknown, rawClass, mode, prefer, complexity,
    level, declaredLevel, declaredComplexity, complexityRecognised, classMinLevel, modeConfigured, promotedFromC0, gate, labels, batchSize, options, prompt, timedOut,
  } = context
  const atMs = safeNow(nowFn)
  const substituted = decision.substituted === true
  const verdict = decision.verdict ?? null
  const adjudication = decision.adjudication ?? null
  const stats = adjudication?.detail ?? (verdict ? probabilityStats(verdict) : { gateValue: null, pMax: null, pMaxOverSecond: null, derivedConfidence: null, probabilities: null })
  const backend = typeof verdict?.backend === 'string' ? verdict.backend : null
  // The EFFECTIVE level is what happened, so the reported complexity is derived
  // from it rather than taken from the caller: after a C0->C2 promotion a record
  // saying `level:'C2_SIMPLE'` next to `complexity:'trivial'` would be the same
  // two-spellings-disagree defect (D2/D12), just written to disk.
  const reportedComplexity = level === null || level === undefined ? null : LEVEL_TO_COMPLEXITY[level] ?? complexity ?? null

  const record = {
    // --- identity and process facts
    ts: new Date(atMs).toISOString(),
    atMs,
    durationMs: Math.max(0, Math.round(atMs - startedAt)),
    question_id: typeof asked.primary?.id === 'string' ? asked.primary.id : null,
    question_text: questionText(asked.primary).slice(0, 500),
    class: declaredClass,
    class_declared: rawClass || null,
    class_unknown: classUnknown === true,
    options_in_order: labels,
    batch_size: batchSize,
    multi_select: asked.primary?.multiSelect === true,
    mode,
    mode_configured: modeConfigured,
    prefer,
    trigger: prefer === 'model-first' ? 'preempt' : 'timeout',
    complexity: reportedComplexity ?? 'unclassified',
    level: level ?? 'unclassified',
    declared_level: declaredLevel ?? 'unclassified',
    declared_complexity: declaredComplexity ?? 'unclassified',
    ...(declaredComplexity === null ? {} : { complexity_recognised: complexityRecognised }),
    class_min_level: classMinLevel,
    promoted_from_c0: promotedFromC0 === true,
    classification: options.classification ?? null,
    // --- the verdict and the gate it had to clear
    source: decision.source,
    substituted,
    applied: substituted,
    advisory: decision.advisory === true,
    applicable: decision.applicable === true,
    requires_post_hoc_review: decision.usable === true || substituted || (verdict !== null && decision.source === 'model'),
    timed_out: timedOut === true,
    chosen: typeof verdict?.choice === 'string' ? verdict.choice : null,
    confidence: typeof verdict?.confidence === 'number' ? verdict.confidence : null,
    p_max: stats.pMax,
    p_max_over_second: stats.pMaxOverSecond,
    probabilities: stats.probabilities,
    confidence_from_pmax: stats.derivedConfidence,
    gate_value: stats.gateValue,
    gate,
    threshold: cfg.confidenceThreshold,
    risk: typeof verdict?.risk === 'string' ? verdict.risk : 'unknown',
    model: backend,
    state_digest: digestOf(prompt?.state ?? asked.primary),
    latency_ms: typeof decision.latencyMs === 'number' ? decision.latencyMs : (typeof verdict?.latencyMs === 'number' ? verdict.latencyMs : null),
    retry_reversed: decision.recheck ? decision.recheck.attempted === true : false,
    agreement: decision.recheck && decision.recheck.attempted === true ? decision.recheck.agreed === true : null,
    // Why this decision cost one model call or two. `skipped-band-capped` is the
    // near-certainty case (a C3 that cleared 0.95): the mitigation does not apply.
    retry_status: decision.recheck ? decision.recheck.status : 'not-considered',
    // When triage declines, the human gets a pre-digested question: what the
    // model recommended, how sure it was, and why. Null when nothing was applied
    // because nothing was ever produced (a transport failure, a hold, etc.).
    recommendation: verdict && substituted !== true
      ? {
          choice: typeof verdict.choice === 'string' ? verdict.choice : null,
          confidence: typeof verdict.confidence === 'number' ? verdict.confidence : null,
          p_max: stats.pMax,
          risk: typeof verdict.risk === 'string' ? verdict.risk : 'unknown',
          reason: typeof verdict.reason === 'string' ? verdict.reason : '',
          backend,
        }
      : null,
    // --- the lifecycle's amendment hooks (the human always wins)
    human_override: false,
    superseded_by: null,
    code: decision.code,
    reason: String(decision.reason ?? '').slice(0, 600),
    low_confidence: decision.lowConfidence === true,
    fallback_used: decision.fallbackUsed === true,
    reversible: isReversible(declaredClass),
    veto_window_ms: cfg.vetoWindowMs,
    veto_until: substituted ? atMs + cfg.vetoWindowMs : null,
    escalate_after_ms: cfg.escalateAfterMs,
    escalate_at: decision.substituted !== true && decision.applicable !== true && timedOut === true && cfg.escalateAfterMs > 0
      ? atMs + cfg.escalateAfterMs
      : null,
  }

  let auditFailed = false
  if (recordFn) {
    try {
      recordFn(record)
    } catch (error) {
      auditFailed = true
      record.audit_failed = true
      record.audit_error = messageOf(error)
    }
  }

  const publicOutcome = {
    answer: substituted || decision.source === 'human' ? decision.answer ?? null : null,
    source: record.source,
    substituted,
    advisory: record.advisory,
    applicable: record.applicable,
    timedOut: record.timed_out,
    confidence: record.confidence,
    verdict,
    record,
    mode,
    decisionClass: declaredClass,
    complexity: reportedComplexity ?? 'unclassified',
    level: level ?? 'unclassified',
    prefer,
    code: record.code,
    reason: record.reason,
    vetoUntil: record.veto_until,
    escalateAt: record.escalate_at,
  }

  // An un-auditable substitution is a silent pass: refuse it.
  if (auditFailed && substituted) {
    const refused = {
      ...record,
      source: 'none',
      substituted: false,
      applied: false,
      advisory: true,
      would_have_substituted: true,
      veto_until: null,
      code: 'audit-failed',
      reason: 'substitution refused: the audit sink threw, and a decision that cannot be audited must not be automated (' + record.audit_error + ')',
    }
    return { ...publicOutcome, answer: null, source: 'none', substituted: false, advisory: true, vetoUntil: null, code: 'audit-failed', reason: refused.reason, record: refused }
  }

  return publicOutcome
}
