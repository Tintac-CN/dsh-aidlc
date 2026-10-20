/**
 * Plugin configuration: the AIDLC process guards, and — separately and
 * explicitly — the decision-model substitution policy.
 *
 * The two halves are deliberately not one switch. Guards are process
 * constraints that protect the artifact chain; the decision layer decides who
 * answers a question. Turning the decision layer down must never weaken a
 * guard, and turning guards down must never widen what a model may decide.
 *
 * ## Why this schema does not call `.volatile()`
 *
 * The harness's own plugin packages mark config subtrees with `.volatile()` to
 * project them into a live Web Settings form, and the schemastery build the
 * harness resolves does provide that method. **The published
 * `@deepseek-ai/schemastery` does not.** Building this schema with it would
 * therefore crash the whole plugin at load time for anyone whose install
 * resolves the public package — a crash in the guards, caused by a UI nicety.
 *
 * So the schema is plain, and configuration arrives through the entry's own
 * `config:` in the profile patch (a first-class, fully supported path) or the
 * `dsh-aidlc` settings namespace. A live form is a worthwhile future addition;
 * it is not worth a load-time crash, and it must not be reintroduced without a
 * capability check.
 *
 * @module dsh-aidlc/config
 */
import z from '@deepseek-ai/schemastery'
import { DECISION_CLASSES, DECISION_CLASS_IDS, NEVER_AUTO, armingWarning } from './decision/policy.js'

/**
 * The class list and the never-auto set come from `decision/policy.js` rather
 * than being restated here. A second copy would drift, and drift in this
 * particular list is a safety problem: a class the policy clamps but the schema
 * does not know about produces "unknown decision class" instead of "this class
 * can never be automated", which reads like a typo rather than a refusal.
 */

export const Config = z.object({
  /**
   * Master switch for the AIDLC process layer (guards, commands, context
   * injection). Off leaves the decision layer dormant too: there is nothing to
   * decide about when no lifecycle is running.
   */
  enabled: z.boolean().default(true),

  /**
   * Auto-route: let a plain natural-language request enter the lifecycle
   * without typing a slash command. This key is the *config-file* default; the
   * per-project switch lives in `docs/aidlc/config.json` and travels with the
   * repository. The project file wins when it exists.
   */
  autoRouting: z.boolean().default(false),

  guards: z.object({
    enabled: z.boolean().default(true),
    /**
     * Deny model-initiated writes to secret-bearing paths (`.env*`, private
     * keys, `.aws/`, `.netrc`, docker config). Template files such as
     * `.env.example` stay writable.
     */
    protectedPaths: z.boolean().default(true),
    /**
     * Deny Construction artifacts (`plan.md`, `units/**`) before Gate#1 is
     * approved — the mechanical form of "no building before the design gate".
     */
    constructionGate: z.boolean().default(true),
    /** Deny edits to test files while the TDD lock is armed. */
    tddLock: z.boolean().default(true),
    /**
     * Deny writes that would drop an existing `history` entry (optimistic lock)
     * or an existing preserve-key (`route`, `testBaseline`, `unitStatus`,
     * `tddLock`, `tddLockPaths`).
     */
    overwriteIntegrity: z.boolean().default(true),
    /**
     * At the `phase -> gate1` transition, mechanically compare the PRD's
     * acceptance-criteria numbers against the test strategy's mapped column.
     * Gaps and phantom numbers deny; unparseable artifacts allow WITH a
     * disclosure (never a silent pass).
     */
    acCoverage: z.boolean().default(true),
  }).default({
    enabled: true,
    protectedPaths: true,
    constructionGate: true,
    tddLock: true,
    overwriteIntegrity: true,
    acCoverage: true,
  }),

  decision: z.object({
    /**
     * Master switch for the decision-model layer. Off = every human question
     * behaves exactly as it did before this plugin existed.
     */
    enabled: z.boolean().default(true),

    /**
     * Per-class mode.
     *
     *  - `triage` **(default for every judgment class)** — consult the decision
     *    model FIRST; if its confidence clears the bar for the decision's risk
     *    band, apply the verdict inside a veto window; otherwise escalate to the
     *    human, carrying the recommendation so their decision is cheap. This is
     *    the mode that makes the human optional for decisions a model can call
     *    confidently.
     *  - `substitute` — a documented alias of `triage`; same behaviour, kept so
     *    existing configurations keep working.
     *  - `advisory` — always ask the human; the model's verdict is recorded and
     *    shown first, and the pipeline stays blocked until they answer. The
     *    default for `gate.approval`.
     *  - `hold` — consult nothing and never time out. The default for the
     *    authority classes.
     *
     * Classes in `decision/policy.js` NEVER_AUTO are clamped in code; editing
     * one here does not widen it and the validator refuses the attempt.
     */
    classes: z.object(
      Object.fromEntries(
        DECISION_CLASS_IDS.map((id) => [
          id,
          z.union(['hold', 'advisory', 'triage', 'substitute']).default(NEVER_AUTO.has(id) ? 'hold' : DECISION_CLASSES[id].defaultMode),
        ]),
      ),
    ).default({}),

    /**
     * Confidence bars by taxonomy level. Complexity **raises the bar** rather
     * than forbidding automation: a harder decision needs more certainty, not
     * necessarily a person.
     *
     * Keyed by the classifier's level vocabulary so the ladder reads in the same
     * terms the audit uses. An override may only **raise** a bar — the resolver
     * takes `max(operatorFloor, bandBar)`, and an unknown level, a non-finite
     * value or one outside [0.5, 1] is ignored, so a typo can never quietly
     * lower a bar.
     *
     * The two upper values are the ones worth calibrating from real outcomes:
     * raise `C3_COMPLEX` if automated calls on hard decisions have been wrong;
     * lower it if they have been right and a human is being bothered for
     * nothing. The audit records the band that applied and the bar it had to
     * clear, so calibration can come from data rather than from guessing.
     */
    levelFloors: z.object({
      /** A deterministic resolver — no model, no human. */
      C0_COMPUTED: z.number().min(0.5).max(1).default(0.6),
      /** Fully reversible, one judgement. */
      C1_TRIVIAL: z.number().min(0.5).max(1).default(0.6),
      /** Reversible but expensive, or a few hidden judgements. */
      C2_SIMPLE: z.number().min(0.5).max(1).default(0.85),
      /** One-way door, security-relevant, or wrong only later. Near-certainty. */
      C3_COMPLEX: z.number().min(0.5).max(1).default(0.95),
    }).default({ C0_COMPUTED: 0.6, C1_TRIVIAL: 0.6, C2_SIMPLE: 0.85, C3_COMPLEX: 0.95 }),

    /**
     * How long a human question waits before the decision model is consulted,
     * in milliseconds. The default is deliberately long: the cost of a wrong
     * automatic decision on a design question is far higher than the cost of
     * waiting. Set 0 to mean "wait for the human forever" (pure advisory lane).
     */
    timeoutMs: z.number().min(0).max(86_400_000).default(900_000),

    /**
     * Second deadline, used only when the first deadline produced an *advisory*
     * rather than a substituted verdict. If the human still has not answered by
     * then, the advisory is escalated (surfaced loudly) and the pipeline keeps
     * blocking. It never converts an advisory into a pass.
     */
    escalateAfterMs: z.number().min(0).max(86_400_000).default(3_600_000),

    /**
     * Minimum model confidence for a substituted verdict to stand. Below it the
     * decision falls back to `onLowConfidence`. 0.6 is the value the reference
     * System One implementation ships (`escalateBelow: 0.60`).
     */
    confidenceThreshold: z.number().min(0.5).max(1).default(0.6),

    /**
     * What a below-threshold model answer means.
     *  - 'block' (default): keep waiting for the human. Fail-closed; the model
     *    declining to be confident is not evidence for either outcome.
     *  - 'advisory': record the low-confidence verdict and keep blocking, but
     *    surface it (so a long-stalled gate still makes progress visible).
     *  - 'defer-model': try the fallback transport once, then block.
     */
    onLowConfidence: z.union(['block', 'advisory', 'defer-model']).default('block'),

    /**
     * How long a substituted decision stays reversible. During this window the
     * operator can veto it and the lifecycle returns to blocked. Substitution
     * without a veto window is not offered.
     */
    vetoWindowMs: z.number().min(0).max(86_400_000).default(600_000),

    /**
     * Never substitute for a decision the model rates `critical`, whatever the
     * confidence. Mirrors the guardian invariant "critical risk is always deny"
     * — except that here even a *deny* is not applied automatically, because the
     * gate's own verdict must stay human.
     */
    blockOnCriticalRisk: z.boolean().default(true),

    /** Deterministic System-0 classification and allow-rules. */
    classify: z.object({
      /**
       * Answer a question without any model call when the classifier rates it
       * `trivial`, every option is reversible, and a rule matches.
       */
      deterministicTrivial: z.boolean().default(true),
      /**
       * Rules that pre-answer a class of question deterministically. Inexpressive
       * on purpose (exact class + literal option label): an allow-rule false
       * positive is a wrong decision nobody reviewed.
       */
      allowRules: z.array(z.object({
        decisionClass: z.string().default(''),
        /** Literal option label to answer with. */
        choose: z.string().default(''),
        /** Optional case-sensitive substring the question must contain. */
        contains: z.string().default(''),
      }).default({ decisionClass: '', choose: '', contains: '' })).default([]),
    }).default({ deterministicTrivial: true, allowRules: [] }),

    /** Where the decision model lives. */
    model: z.object({
      /**
       * 'systemone' = a System One / Jev decision API (TypeSafe, SiliconFlow, or
       * a self-hosted Laya). 'chat' = an OpenAI-compatible chat endpoint.
       * 'session' = the harness's own model for the current session via ctx.llm.
       */
      protocol: z.union(['systemone', 'chat', 'session']).default('session'),
      /** Empty resolves to the protocol's own default (SiliconFlow for systemone). */
      baseURL: z.string().default(''),
      model: z.string().default(''),
      apiKey: z.string().role('secret').default(''),
      apiKeyEnv: z.string().default(''),
      apiKeyFile: z.string().default(''),
      timeoutMs: z.number().min(1000).max(600_000).default(24_000),
      maxTokens: z.number().min(16).max(32_000).default(1024),
      /** Request-side context budget for a System One state payload. 0 = inherit. */
      maxLen: z.number().min(0).max(200_000).default(0),
      /** 'off' disables request-side reasoning traces (verdicts are final text only). */
      thinking: z.union(['default', 'off']).default('off'),
      /** Extra operator policy appended to the built-in decision policy. */
      extraPolicy: z.string().default(''),
    }).default({
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
  }).default({
    enabled: true,
    classes: {},
    levelFloors: { C0_COMPUTED: 0.6, C1_TRIVIAL: 0.6, C2_SIMPLE: 0.85, C3_COMPLEX: 0.95 },
    timeoutMs: 900_000,
    escalateAfterMs: 3_600_000,
    confidenceThreshold: 0.6,
    onLowConfidence: 'block',
    vetoWindowMs: 600_000,
    blockOnCriticalRisk: true,
    classify: { deterministicTrivial: true, allowRules: [] },
    model: {
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
    },
  }),

  /** Run the declared verification command and compare against the recorded baseline. */
  baseline: z.object({
    enabled: z.boolean().default(true),
    /** Hard cap on the verification command's wall clock. */
    timeoutMs: z.number().min(1000).max(3_600_000).default(600_000),
  }).default({ enabled: true, timeoutMs: 600_000 }),

  /** Where decision audit lines are written (JSONL, one line per decision). */
  audit: z.object({
    enabled: z.boolean().default(true),
    /** Relative paths resolve from the session workspace. */
    path: z.string().default('docs/aidlc/decision-audit.jsonl'),
  }).default({ enabled: true, path: 'docs/aidlc/decision-audit.jsonl' }),
})

/**
 * Validate the resolved configuration. Returns `null` when usable, otherwise a
 * message naming the exact problem.
 *
 * A configuration that fails this check must never be armed: every branch here
 * guards a way the operator could accidentally widen what a model decides.
 *
 * @param {object} c - resolved config.
 * @returns {string|null} the problem, or null.
 */
export function validateConfig(c) {
  if (!c || typeof c !== 'object') return 'config must be an object'
  const d = c.decision
  if (!d || typeof d !== 'object') return 'config.decision must be an object'

  if (d.enabled) {
    if (typeof d.confidenceThreshold !== 'number' || !Number.isFinite(d.confidenceThreshold) || d.confidenceThreshold < 0.5 || d.confidenceThreshold > 1) {
      return 'invalid decision.confidenceThreshold: must be a finite number in [0.5, 1]'
    }
    if (!Number.isFinite(d.timeoutMs) || d.timeoutMs < 0) {
      return 'invalid decision.timeoutMs: must be a finite number >= 0'
    }
    if (d.onLowConfidence === 'defer-model' && d.model && d.model.protocol === 'session') {
      // Not fatal, but 'defer-model' with a single transport has no fallback to
      // defer to; say so rather than silently behaving like 'block'.
      return 'decision.onLowConfidence="defer-model" needs a decision.model.protocol other than "session" (there is no second transport to defer to)'
    }
    const model = d.model
    if (!model || typeof model !== 'object') return 'config.decision.model must be an object'
    if (model.protocol === 'systemone' || model.protocol === 'chat') {
      const key = [model.apiKey, model.apiKeyEnv, model.apiKeyFile].some((v) => typeof v === 'string' && v.trim() !== '')
      const base = typeof model.baseURL === 'string' ? model.baseURL.trim() : ''
      // A loopback endpoint may legitimately run unauthenticated; anything else
      // must present a key, and refusing here is the fail-closed direction.
      if (!key && !isLoopbackUrl(base)) {
        return `decision.model.protocol="${model.protocol}" needs an API key (decision.model.apiKey / apiKeyEnv / apiKeyFile); only a loopback baseURL may run unauthenticated`
      }
    }
    if (model.protocol === 'session' && !model.model && !allowSessionDefault(c)) {
      return null // session model resolves the running provider/model at call time
    }
    for (const rule of d.classify?.allowRules ?? []) {
      if (!rule.decisionClass || !rule.choose) {
        return 'invalid decision.classify.allowRules entry: decisionClass and choose must both be non-empty'
      }
      if (!DECISION_CLASS_IDS.includes(rule.decisionClass)) {
        return `invalid decision.classify.allowRules entry: unknown decisionClass ${JSON.stringify(rule.decisionClass)}`
      }
    }
  }

  const classes = d.classes ?? {}
  for (const [id, mode] of Object.entries(classes)) {
    if (!DECISION_CLASS_IDS.includes(id)) {
      return `invalid decision.classes key ${JSON.stringify(id)}: unknown decision class`
    }
    if (mode !== 'hold' && mode !== 'advisory' && mode !== 'triage' && mode !== 'substitute') {
      return `invalid decision.classes["${id}"]: must be "hold", "advisory", "triage" or "substitute"`
    }
    if ((mode === 'triage' || mode === 'substitute') && NEVER_AUTO.has(id)) {
      // Refused at load, and clamped again by resolveMode at run time. The
      // refusal is the loud half: an operator who wrote this believes it works,
      // and silently honouring the class's safe default would leave them with a
      // false belief about what their pipeline automates.
      // Name the spelling the operator actually wrote: `substitute` and `triage`
      // are aliases, so echoing a fixed one would tell someone who wrote
      // `"triage"` that `"substitute"` was refused — a confusing message in the
      // one place whose only job is to explain what went wrong.
      return `decision.classes["${id}"]="${mode}" is refused: this class can never be auto-decided, at any confidence. It is clamped in code (decision/policy.js NEVER_AUTO), so the override would have had no effect. Remove it to leave the class at its safe default.`
    }
  }

  if (c.audit && typeof c.audit.path !== 'string') return 'invalid audit.path: must be a string'
  return null
}

/**
 * Non-fatal advisories about an otherwise-usable configuration.
 *
 * Separate from `validateConfig` on purpose. A validation failure disarms the
 * decision layer; these are things the operator should know but that must NOT
 * stop the plugin, because they are deliberate choices rather than errors.
 *
 * @param {object} c - resolved config.
 * @returns {string[]} advisories, empty when there are none.
 */
export function configWarnings(c) {
  /** @type {string[]} */
  const out = []
  const classes = c?.decision?.classes ?? {}
  // The gate warning text lives in policy.js next to the class table, so it can
  // never drift from what the resolver actually does with the class. Duplicating
  // the message here would mean two places to update and one of them would rot.
  for (const [id, mode] of Object.entries(classes)) {
    const warning = armingWarning(id, mode)
    if (warning !== null) out.push(warning)
  }
  const floors = c?.decision?.levelFloors ?? {}
  const floor = c?.decision?.confidenceThreshold
  if (typeof floors.C2_SIMPLE === 'number' && typeof floor === 'number' && floors.C2_SIMPLE < floor) {
    out.push(
      `decision.levelFloors.C2_SIMPLE (${floors.C2_SIMPLE}) is below decision.confidenceThreshold (${floor}), so the C2 bar ` +
        'is lower than the general floor. Raise it, or lower the floor if that was the intent.',
    )
  }
  if (typeof floors.C3_COMPLEX === 'number' && typeof floors.C2_SIMPLE === 'number' && floors.C3_COMPLEX < floors.C2_SIMPLE) {
    out.push(
      `decision.levelFloors.C3_COMPLEX (${floors.C3_COMPLEX}) is below decision.levelFloors.C2_SIMPLE (${floors.C2_SIMPLE}). ` +
        'A harder decision now needs less certainty than an easier one, which inverts the risk ladder.',
    )
  }
  return out
}

/** True for a URL that addresses this machine (an unauthenticated local decision server is legitimate). */
function isLoopbackUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return false
  let host
  try {
    host = new URL(s).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host === 'localhost' || host === '::1') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return v4 !== null && Number(v4[1]) === 127
}

/** Placeholder for a future session-default resolution; kept so the branch above reads intent. */
function allowSessionDefault() {
  return true
}

/**
 * Detach schemastery's volatile wrappers from a parsed config so read paths can
 * treat it as plain data.
 *
 * @param {unknown} value - possibly-wrapped config value.
 * @returns {unknown} the same shape with wrappers unwrapped.
 */
export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value
  const wrapper = /** @type {{get?: unknown}} */ (value)
  if (typeof wrapper.get === 'function') {
    try {
      return plainConfig(/** @type {() => unknown} */ (wrapper.get)())
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map(plainConfig)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = plainConfig(v)
  return out
}
