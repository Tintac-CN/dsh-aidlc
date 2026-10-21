/**
 * dsh-aidlc — AI-DLC as a native DeepSeek Harness plugin, with a Jev-style
 * decision-model layer.
 *
 * This module is WIRING ONLY. Every decision it makes is delegated to a module
 * with a frozen interface (`docs/design.md` §4): the guards in `lib/aidlc/*`,
 * the decision layer in `lib/decision/*`, and the human/model surface in
 * `lib/surface/*`. Keeping the wiring thin is what lets those modules be unit
 * tested with no harness running.
 *
 * What it registers:
 *   - `tools/pre-execute`      → the process guards (secret paths, gates, TDD lock, audit integrity)
 *   - `tools/post-execute`     → the TDD-lock warning and any deferred disclosure
 *   - `agent/session-start`    → lifecycle warm-up context
 *   - `agent/pre-step`         → the auto-route contract
 *   - `user-questions/request` → the decision-model seam (PREPENDED)
 *   - commands and tools via `lib/surface/*`
 *
 * @module dsh-aidlc
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, configWarnings, plainConfig, validateConfig } from './config.js'
import { NS, inject, injectSource, name, sourceKind } from './meta.js'
import * as guards from './aidlc/guards.js'
import * as stateApi from './aidlc/state.js'
import * as ledgerApi from './aidlc/ledger.js'
import { createAuditSink } from './decision/audit.js'
import { classify } from './decision/classify.js'
import { callChatReviewer, callSessionModelReviewer } from './decision/reviewer.js'
import { callSystemone, DEFAULT_SYSTEMONE_BASE_URL, DEFAULT_SYSTEMONE_MODEL } from './decision/systemone.js'
import { resolveMode } from './decision/policy.js'
import * as policyApi from './decision/policy.js'
import { arbitrate } from './decision/arbiter.js'
import { registerCommands } from './surface/commands.js'
import { registerTools } from './surface/tools.js'
import { AIDLC_LIFECYCLE_ORDER, AIDLC_LIFECYCLE_SECTION, AIDLC_LIFECYCLE_TEXT, promptRoutingContext, sessionStartContext } from './surface/context.js'
import { registerSkills } from './skills.js'
import { AIDLC_PRESET_ID, installPreset, isAidlcMode } from './presets.js'

export { Config, inject, name, NS, sourceKind }

/** Tool names whose arguments carry a file path we must guard. */
const FILE_WRITE_TOOLS = /^(write|edit|multi_edit|notebook_edit|str_replace_editor|create_file|apply_patch)$/i

/** Producer stamp for every message this plugin injects. */
const PLUGIN_SOURCE = injectSource({ kind: sourceKind })

/**
 * Wire the plugin into a composition.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {unknown} rawConfig - the entry config handed to `apply`.
 */
export function apply(ctx, rawConfig) {
  const log = ctx.logger(name)
  const config = resolveConfig(rawConfig, log)

  // ── Fail-closed arming ────────────────────────────────────────────────────
  // A configuration that fails validation does NOT weaken the guards; it
  // disarms the decision layer. The guards are the safety net, the decision
  // layer is the risk, so an unusable config must lose the risk and keep the
  // net.
  const validationError = validateConfig(config)
  const decisionEnabled = config.decision.enabled && validationError === null
  if (validationError !== null) {
    log.error(
      `decision layer DISARMED — ${validationError}. ` +
        'Process guards remain active. Fix the config (or set decision.enabled=false to silence this).',
    )
  }

  // Advisories: choices that are the operator's to make, but whose consequences
  // they may not have intended. They disarm nothing — the point is that "we warn
  // loudly instead of refusing" has to actually reach a log, or armability is
  // indistinguishable from a setting that does nothing. That failure has already
  // happened twice in this project (the `allowAuto` flag, and the inert gate),
  // so an unlogged warning is treated as a bug rather than a nicety.
  for (const warning of configWarnings(config)) log.warn(`AIDLC config: ${warning}`)

  /**
   * Audit sinks, one per workspace root.
   *
   * `createAuditSink` resolves its JSONL path against a single root at
   * construction time, and one harness process can serve several workspaces — so
   * the sink is keyed by root rather than shared, otherwise two projects would
   * fold their decision histories into one file. The map is bounded by the
   * number of workspaces a process opens, which is small.
   */
  const auditSinks = new Map()
  const auditFor = (root) => {
    const key = typeof root === 'string' ? root : ''
    let sink = auditSinks.get(key)
    if (sink === undefined) {
      sink = createAuditSink({
        enabled: config.audit.enabled,
        path: config.audit.path,
        root: key,
        onError: (error) => log.warn(`AIDLC decision audit write failed: ${String(error)}`),
      })
      auditSinks.set(key, sink)
    }
    return sink
  }

  /**
   * The audit surface the rest of the plugin sees.
   *
   * `write` is synchronous and never throws — an audit failure must not convert
   * an already-resolved decision into an error, and the arbiter's `deps.record`
   * contract is synchronous. `flush` awaits durability for the operator command
   * and for teardown.
   */
  const audit = {
    write(entry) {
      try {
        return auditFor(entry?.root).record(entry)
      } catch (error) {
        log.warn(`AIDLC decision audit could not record an entry: ${String(error)}`)
        return { ok: false, code: 'threw' }
      }
    },
    async flush() {
      for (const sink of auditSinks.values()) {
        try {
          await sink.flush()
        } catch (error) {
          log.warn(`AIDLC decision audit flush failed: ${String(error)}`)
        }
      }
    },
    sinks: () => [...auditSinks.values()],
  }

  /**
   * Disclosure carried from `pre-execute` to `post-execute` for one call.
   *
   * `PreToolDecision` has no "allow, but here is why" channel — it is allow,
   * deny or ask. A guard that allows WITH a disclosure (the AC-coverage
   * unparseable branch) therefore has to deliver its reason out of band. Keyed
   * by callId and cleared on read, so a disclosure can never leak onto an
   * unrelated call.
   *
   * @type {Map<string, string>}
   */
  const pendingDisclosure = new Map()

  /**
   * Build the decision-model client for this config.
   *
   * Returned function has the frozen `consultModel(prompt, {signal})` shape.
   * Every transport failure propagates as a throw; `arbitrate` is responsible
   * for turning that into a fail-closed outcome, so this function must NOT
   * swallow errors into a benign default.
   */
  const consultModel = buildConsultModel({ ctx, config, log })

  /**
   * The workspace root for a call.
   *
   * A session always carries `cwd` in practice, but if it ever does not, the
   * guards must NOT simply switch themselves off — that is a fail-open path
   * where the whole guard set silently stops protecting while every other
   * layer still reports "armed". Fall back to the process working directory
   * (which is what `lib/aidlc/guards.js` does internally for a missing root)
   * and say so once, loudly, so an operator can see that the guard is now
   * judging a path relative to a guess.
   */
  let warnedMissingRoot = false
  const rootOf = (agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    if (!warnedMissingRoot) {
      warnedMissingRoot = true
      log.warn(
        'a guarded tool call has no session workspace; falling back to the process working directory. ' +
          'Guards remain active, but they are judging paths relative to that directory.',
      )
    }
    return process.cwd()
  }

  // ── Guards: before a tool runs ────────────────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!config.enabled || !config.guards.enabled) return next()
    if (!FILE_WRITE_TOOLS.test(exec.name)) return next()

    const root = rootOf(exec.agent)
    if (root === undefined) return next()

    const args = /** @type {Record<string, unknown>} */ (exec.arguments ?? {})
    const filePath = String(args.file_path ?? args.path ?? args.filePath ?? '')
    if (filePath === '') {
      // Every write-shaped tool this plugin knows about takes a path, so a
      // missing one means either a new tool with an argument name we do not
      // recognize, or a malformed call. It cannot be guarded — there is nothing
      // to match on — but it must not pass in SILENCE, because "no path" and
      // "path that passed every rule" would otherwise look identical in the log.
      log.warn(
        `a write-shaped tool call (${exec.name}) carried no recognizable path argument, so no guard could evaluate it. ` +
          'If this tool can write files, its path argument needs adding to the pre-execute path lookup.',
      )
      return next()
    }

    const isEdit = /edit/i.test(exec.name)
    let decision
    try {
      decision = guards.guardWrite({
        filePath,
        isEdit,
        content: typeof args.content === 'string' ? args.content : undefined,
        root,
        // The guard flags come from `config.guards`, but the gate-receipt rule
        // also needs the DECISION config: whether an AUTO receipt may satisfy a
        // gate is derived from the effective mode of `gate.approval`, and the
        // guard refuses to take that as a bare boolean. Passing only
        // `config.guards` therefore left `acceptAuto` permanently false and made
        // an armed gate silently inert — the feature looked configured and did
        // nothing. The decision sub-config travels with the flags for that one
        // derivation; `guards.js` reads every flag from `config.guards` when it
        // is present, so an explicit `guards.*` override is still honoured.
        config: { ...config.guards, locale: config.locale, decision: config.decision },
      })
    } catch (error) {
      // A guard that cannot run is a guard that cannot protect. Fail closed and
      // say so, rather than letting the write through because the checker broke.
      const reason = `AIDLC guard failed to evaluate "${filePath}": ${String(error)}. Denying rather than allowing an unchecked write.`
      log.error(reason)
      audit.write({ root, kind: 'guard-error', filePath, tool: exec.name, error: String(error) })
      return { kind: 'deny', reason }
    }

    if (decision.kind === 'deny') {
      audit.write({ root, kind: 'guard-deny', filePath, tool: exec.name, reason: decision.reason })
      return { kind: 'deny', reason: decision.reason }
    }
    if (decision.kind === 'allow-with-disclosure') {
      // Never silent: keep the reason attached to this call and surface it.
      pendingDisclosure.set(String(exec.callId ?? ''), decision.reason)
      audit.write({ root, kind: 'guard-disclose', filePath, tool: exec.name, reason: decision.reason })
      log.warn(`AIDLC guard allowed "${filePath}" with a disclosure: ${decision.reason}`)
    }
    return next()
  })

  // ── Guards: after a tool runs ─────────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!config.enabled || !config.guards.enabled) return next()
    const root = rootOf(exec.agent)
    const contexts = []

    if (root !== undefined) {
      const disclosure = pendingDisclosure.get(String(exec.callId ?? ''))
      if (disclosure !== undefined) {
        pendingDisclosure.delete(String(exec.callId ?? ''))
        contexts.push(textMessage(`AIDLC guard disclosure: ${disclosure}`))
      }
      if (FILE_WRITE_TOOLS.test(exec.name)) {
        const args = /** @type {Record<string, unknown>} */ (exec.arguments ?? {})
        const filePath = String(args.file_path ?? args.path ?? args.filePath ?? '')
        if (filePath !== '') {
          try {
            const warning = guards.guardTestsPostWrite({ filePath, root, config: config.guards })
            if (warning.kind === 'warn') contexts.push(textMessage(warning.message))
          } catch (error) {
            log.warn(`AIDLC post-write guard failed for "${filePath}": ${String(error)}`)
          }
        }
      }
    }

    const downstream = await next()
    if (contexts.length === 0) return downstream
    return {
      ...downstream,
      additionalContexts: [...contexts, ...(downstream.additionalContexts ?? [])],
    }
  })

  // ── Session warm-up ───────────────────────────────────────────────────────
  ctx.on('agent/session-start', ({ agent }) => {
    if (!config.enabled) return
    const root = rootOf(agent)
    if (root === undefined) return
    try {
      // The mode forces routing on, and the switch line reports the EFFECTIVE
      // state rather than asserting one — so the warm-up can never promise
      // routing the session does not have.
      const text = sessionStartContext({ root, config, ...(isAidlcMode(ctx, agent) ? { autoRouteOverride: true } : {}) })
      if (typeof text === 'string' && text.trim() !== '') agent.inject(textMessage(text))
    } catch (error) {
      // A failed warm-up must never stop a session from starting.
      log.warn(`AIDLC session warm-up failed: ${String(error)}`)
    }
  })

  // ── AIDLC mode: one named system-prompt section ───────────────────────────
  //
  // What the mode MEANS lives in exactly one place — the `aidlc:lifecycle`
  // section text in `lib/surface/context.js`. It used to exist three times (the
  // preset persona, the session banner, this contract), which is how an agent
  // ends up following two versions of the same instruction.
  //
  // Registering through `agent.ctx.inject(['systemPrompt'], …)` files the section
  // into that agent's own scope layer (scope determines both visibility and
  // effect ownership), so it cannot leak to sessions outside the mode and it
  // unwinds with the agent. This is the shipped precedent from
  // `dsh-file-reference-local`: register on `agent/created`, dispose on
  // `agent/disposed`.
  const lifecycleSections = new WeakMap()
  const installLifecycleSection = (agent) => {
    if (!config.enabled) return
    if (lifecycleSections.has(agent)) return
    if (!isAidlcMode(ctx, agent)) return
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: AIDLC_LIFECYCLE_SECTION,
          order: AIDLC_LIFECYCLE_ORDER,
          // Static by design: the prompt is assembled per request, and a section
          // whose text changes without a logged reason is request-cache instability.
          text: AIDLC_LIFECYCLE_TEXT,
        })
      })
      lifecycleSections.set(agent, fiber)
    } catch (error) {
      // A mode that cannot register its section is a degraded mode, not a broken
      // session: the preset persona still carries the short statement.
      log.warn(`AIDLC could not register the ${AIDLC_LIFECYCLE_SECTION} prompt section: ${String(error)}`)
    }
  }
  ctx.on('agent/created', ({ agent }) => { installLifecycleSection(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = lifecycleSections.get(agent)
    lifecycleSections.delete(agent)
    if (fiber === undefined) return
    try {
      // `agent.ctx.inject` registrations unwind with the agent's scope anyway;
      // disposing explicitly keeps a long-lived process from holding the fiber.
      if (typeof fiber.dispose === 'function') void fiber.dispose()
    } catch (error) {
      log.warn(`AIDLC could not dispose the ${AIDLC_LIFECYCLE_SECTION} prompt section: ${String(error)}`)
    }
  })
  // A blank session may switch preset after creation (the roster locks it only
  // once it has produced something), so re-evaluate when the selection lands.
  ctx.on('agent/session-start', ({ agent }) => { installLifecycleSection(agent) })

  // ── Auto-route contract ───────────────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (!config.enabled) return next()
    const root = rootOf(agent)
    if (root === undefined) return next()
    // AIDLC **mode** implies auto-routing. Choosing the mode *is* the opt-in, so
    // the agent gets the routing contract from the first message whether or not
    // the project's docs/aidlc/config.json has been flipped — requiring both the
    // mode and a switch would be exactly the redundant step the mode removes.
    //
    // This is supplied as an explicit OVERRIDE rather than as a config default,
    // because it must outrank the project file. Choosing a mode for this session
    // is a more specific and later act than a repository default, so a repo whose
    // file says `autoRouting:false` still routes while the mode is selected. The
    // project file continues to govern every session that is not in the mode.
    const mode = isAidlcMode(ctx, agent)
    let text = null
    try {
      text = promptRoutingContext({
        root,
        prompt: messages.flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text).join(''),
        config,
        ...(mode ? { autoRouteOverride: true } : {}),
      })
    } catch (error) {
      log.warn(`AIDLC route context failed: ${String(error)}`)
      return next()
    }
    const downstream = await next()
    if (text === null || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages, textMessage(text)] }
  })

  // ── The decision-model seam ───────────────────────────────────────────────
  // PREPENDED: registered with `true` so this answerer is consulted before the
  // interactive one. It claims a question only when the decision layer actually
  // resolved it; otherwise it calls `next()` and the human answers exactly as
  // they would have without this plugin.
  //
  // SESSION SCOPING — this is a correctness requirement, not a preference.
  // The listener is registered at the root scope, so it receives the question
  // waterfall for EVERY session in the process, including ordinary coding
  // sessions that never asked for AI-DLC. Triage would then answer a
  // `generic.question` with a model, the human would never see it, and their
  // turn would move on without the answer they needed — which is precisely the
  // report of "some questions can't be answered and the turn ends early".
  //
  // So interception is limited to a session that is actually in AIDLC mode.
  // `decision.interceptAllSessions` exists for an operator who wants the
  // decision layer everywhere, and it is OFF by default: quietly answering other
  // people's questions is not a thing a plugin should do because it happened to
  // be installed.
  if (decisionEnabled) {
    const answerer = makeQuestionAnswerer({ ctx, config, log, audit, consultModel, rootOf })
    ctx.on(
      'user-questions/request',
      async (request, next) => {
        if (!isAidlcMode(ctx, request.agent) && config.decision.interceptAllSessions !== true) return next()
        return answerer(request, next)
      },
      true,
    )
  }

  // ── Surface ───────────────────────────────────────────────────────────────
  // The skill provider is registered first and independently: a composition with
  // no skill registry, or an asset that fails to load, must never stop the
  // guards from arming.
  // ── AIDLC mode: declared in the bundle patch, NOT installed into a directory ─
  // This used to write the preset into `<dshHome>/.agent-presets/aidlc/` on every
  // boot. That was correct for harness 0.1.x, whose roster scanned directories;
  // **v0.2.1 removed directory scanning entirely** (`dsh-agent-preset-registry`:
  // "the registry neither scans directories nor accepts preset paths"), so the
  // write recreated a dead directory on every start and nothing ever read it.
  //
  // The mode is now a `@deepseek-ai/dsh-agent-preset` row in `cordis.patch.yml`,
  // generated from the installed `standard` preset by `scripts/sync-preset.mjs`.
  // Re-enabling the installer would be this project's recurring failure mode: a
  // side effect that looks like it configures the product and does not.

  try {
    registerSkills({ ctx, log })
  } catch (error) {
    log.error(`AIDLC bundled skills failed to register: ${String(error)}`)
  }

  const surfaceDeps = {
    config,
    log,
    audit,
    decisionEnabled,
    guards,
    state: stateApi,
    ledger: ledgerApi,
    classify,
    resolveMode,
    consultModel,
    arbitrate,
    // The whole policy namespace, so the surface can read the authority set and
    // the per-level bars from their single definition instead of restating them.
    // A duplicated authority list is the exact drift this project already paid
    // for once (the receipt pattern), and the failure mode here is worse: a stale
    // copy would report `hold` for a class the operator had deliberately lifted,
    // or claim a class is clamped when it is not.
    policy: policyApi,
  }
  try {
    registerCommands({ ctx, deps: surfaceDeps })
  } catch (error) {
    log.error(`AIDLC commands failed to register: ${String(error)}`)
  }
  try {
    registerTools({ ctx, deps: surfaceDeps })
  } catch (error) {
    log.error(`AIDLC tools failed to register: ${String(error)}`)
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  // The disposer returns the flush promise so disposal actually awaits
  // durability instead of racing the process exit.
  ctx.effect(() => () => {
    pendingDisclosure.clear()
    return audit.flush()
  }, 'dsh-aidlc: release per-call disclosure state and flush the audit sinks')

  log.info(
    `armed: guards=${config.guards.enabled ? 'on' : 'off'} ` +
      `decision=${decisionEnabled ? `on (${config.decision.model.protocol}, threshold ${config.decision.confidenceThreshold}, timeout ${config.decision.timeoutMs}ms)` : 'off'}`,
  )
}

/**
 * Build the `user-questions/request` answerer — **substitution point A**, the
 * pre-emption path.
 *
 * ## Why this function only pre-empts, and never "answers after a timeout"
 *
 * DSH's question service owns a human question for its whole life, and its
 * documented invariant is that it *never fabricates a result for a finished
 * call*: the wait deadline produces a `pending` business outcome
 * (`ASK_TIMED_OUT`), the question stays answerable, and a late human reply
 * arrives later as an ordinary reply message.
 *
 * A waterfall listener that raced the human and then returned a synthesized
 * answer on timeout would violate exactly that invariant — it would settle a
 * call the platform deliberately left open, and it would race the real late
 * answer. So this listener has exactly two outcomes:
 *
 *   - **claim it** — consult the decision model *before* the human is asked, and
 *     answer only if the model is confident. The human never sees the question.
 *     This is legitimate: the question should never have reached them.
 *   - **`next()`** — everyone else's question, answered by the human exactly as
 *     it would have been without this plugin.
 *
 * The "the human timed out, now what?" path is **substitution point B**, and it
 * lives at the lifecycle level (`aidlc_decide` plus the skill protocol): it
 * consults the model, records a decision record, and unblocks the *pipeline* —
 * without touching the settled question. If the human answers late, the human
 * wins and the record is amended.
 *
 * A hard rule this function encodes: **it never claims a request it did not
 * actually resolve.** `arbitrate` reports `answer: null` on every fail-closed
 * path, and a null answer delegates.
 *
 * @param {{ctx: any, config: any, log: any, audit: any, consultModel: any, rootOf: any}} deps
 * @returns {(request: any, next: any) => Promise<any>}
 */
function makeQuestionAnswerer({ config, log, audit, consultModel, rootOf }) {
  return async function answerWithDecisionLayer(request, next) {
    const human = () => next()
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return human()

    const root = rootOf(request.agent) ?? undefined

    // Classify only the FIRST question: a multi-question form is one human
    // interaction, and answering some of its questions automatically while the
    // human answers the rest would produce a half-machine form that no single
    // party reviewed.
    const primary = questions[0]
    let classification
    try {
      classification = classify(primary, { decisionClass: primary?.aidlcClass, root })
    } catch (error) {
      log.warn(`AIDLC classification failed; deferring to the human: ${String(error)}`)
      return human()
    }

    const mode = resolveMode({ decisionClass: classification.decisionClass, config: config.decision })

    // `triage` (and its alias `substitute`) is the only lane that may claim a
    // question here: consult the model first, and let the *confidence bar for
    // this decision's risk band* decide whether a human is needed. Complexity
    // raises that bar — it does not forbid the model from answering, because a
    // hard decision a model can call at 95% should not interrupt a person.
    //
    // `hold` consults nothing and defers to the human. `advisory` also defers:
    // the human is about to answer this question, so adjudicating behind their
    // back would let the recorded advice and the real decision disagree. The
    // advisory verdict is produced at the lifecycle level instead (point B).
    if (mode !== 'triage' && mode !== 'substitute') return human()

    // A form is triaged only when EVERY question is triageable. Otherwise the
    // human sees the whole form, so no question is answered twice.
    if (questions.length > 1) {
      const allPreEmptable = questions.every((q) => {
        try {
          const c = classify(q, { decisionClass: q?.aidlcClass, root })
          const m = resolveMode({ decisionClass: c.decisionClass, config: config.decision })
          return m === 'triage' || m === 'substitute'
        } catch {
          return false
        }
      })
      if (!allPreEmptable) return human()
    }

    let outcome
    try {
      outcome = await arbitrate({
        request,
        questions,
        decisionClass: classification.decisionClass,
        complexity: classification.complexity,
        classification,
        // The session-model transport needs to know WHICH model to use, and only
        // the caller holds the agent. Without these the transport throws "the
        // session has no provider/model" on every call, which fails closed (the
        // human answers) but silently makes the whole feature inert under the
        // default `protocol: 'session'`. The arbiter forwards both into the
        // prompt; it cannot discover them itself.
        provider: request.agent?.options?.provider,
        model: request.agent?.options?.model,
        deps: {
          // Never called on the pre-emption path: the whole point is that the
          // human is not asked. It throws rather than silently blocking, so a
          // future refactor that starts racing would fail loudly in tests
          // instead of quietly double-answering a question.
          askHuman: () => {
            throw new Error('the pre-emption path must not ask the human')
          },
          consultModel,
          record: (entry) => audit.write({ root, kind: 'decision', trigger: 'preempt', ...entry }),
          now: () => Date.now(),
        },
        config: config.decision,
        prefer: 'model-first',
        signal: request.signal,
      })
    } catch (error) {
      // arbitrate is documented never to throw; if it does, that is a bug and
      // the only safe direction is the human.
      log.error(`AIDLC decision arbitration threw; deferring to the human: ${String(error)}`)
      audit.write({ root, kind: 'decision-error', error: String(error), decisionClass: classification.decisionClass })
      return human()
    }

    const resolved =
      outcome !== null &&
      outcome !== undefined &&
      outcome.answer !== null &&
      outcome.answer !== undefined &&
      outcome.substituted === true

    if (!resolved) {
      // The model did not clear the bar for this decision's risk band, so a
      // human is needed after all — but a bare question wastes their attention,
      // which is the cost this whole layer exists to reduce. Hand them the
      // verdict that was produced, with its confidence, so they confirm or
      // overrule a recommendation instead of forming an opinion from scratch.
      const verdict = outcome?.verdict ?? null
      if (verdict !== null && verdict !== undefined) {
        const recommendation = describeVerdict(verdict)
        // The bar lives on the audit record (`gate`), not on the outcome — the
        // arbiter's public shape carries the verdict, and the record carries why.
        // Reading `outcome.bar` looked right and was silently always-undefined,
        // so the operator never saw which bar the escalation fell short of.
        const bar = outcome?.record?.gate ?? outcome?.bar ?? null
        const gap = bar !== null && typeof outcome?.confidence === 'number' ? ` (bar for this band: ${bar})` : ''
        log.info(
          `AIDLC escalated ${classification.decisionClass} to the human: the model suggested ` +
            `${recommendation || '(no choice)'} at p_max ${outcome.confidence ?? 'n/a'}${gap}.`,
        )
        // Inject as conversation context rather than mutating the question: the
        // question belongs to the caller, and rewriting it would change what the
        // human was asked. Context is additive and cannot alter the options.
        try {
          if (request.agent !== undefined && recommendation !== '') {
            request.agent.inject(
              textMessage(
                `AIDLC decision support — the decision model was consulted first on a ${classification.decisionClass} decision ` +
                  `and did not reach the confidence this class requires${gap}, so your judgement is needed. ` +
                  `Its recommendation: ${recommendation} (p_max ${outcome.confidence ?? 'n/a'}). ` +
                  `Reason: ${typeof verdict.reason === 'string' && verdict.reason !== '' ? verdict.reason : '(none recorded)'} ` +
                  `Treat this as advice, not a decision — it is recorded in the decision audit either way.`,
              ),
            )
          }
        } catch (error) {
          // Injection is a courtesy; failing it must not stop the human's question.
          log.warn(`AIDLC could not attach the decision-model recommendation to the escalation: ${String(error)}`)
        }
      }
      return human()
    }
    log.info(
      `AIDLC pre-empted a ${classification.decisionClass} decision via ${outcome.source} ` +
        `(p_max ${outcome.confidence ?? 'n/a'}, veto window ${config.decision.vetoWindowMs}ms).`,
    )
    return outcome.answer
  }
}

/**
 * Build the transport-independent `consultModel(prompt, {signal})` function.
 *
 * @param {{ctx: any, config: any, log: any}} deps
 * @returns {(prompt: any, opts?: {signal?: AbortSignal}) => Promise<any>}
 */
function buildConsultModel({ ctx, config, log }) {
  const m = config.decision.model
  return async function consultModel(prompt, opts = {}) {
    if (m.protocol === 'systemone') {
      const baseURL = m.baseURL.trim() || DEFAULT_SYSTEMONE_BASE_URL
      const model = m.model.trim() || DEFAULT_SYSTEMONE_MODEL
      const apiKey = await resolveApiKey(m)
      const result = await callSystemone({
        baseURL,
        model,
        apiKey,
        state: prompt.state,
        questions: prompt.questions,
        maxLen: m.maxLen,
        timeoutMs: m.timeoutMs,
        signal: opts.signal,
        fetch: globalThis.fetch,
      })
      return normalizeSystemone(result, prompt)
    }

    if (m.protocol === 'chat') {
      const apiKey = await resolveApiKey(m)
      const text = await callChatReviewer({
        baseURL: m.baseURL,
        model: m.model,
        apiKey,
        system: prompt.system,
        user: prompt.user,
        maxTokens: m.maxTokens,
        timeoutMs: m.timeoutMs,
        thinking: m.thinking,
        signal: opts.signal,
        fetch: globalThis.fetch,
      })
      return parseVerdictText(text)
    }

    // 'session' — the harness's own model for this session. No credential
    // handling lives here: the harness already owns provider auth.
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('decision.model.protocol="session" needs an llm service in this composition')
    }
    return callSessionModelReviewer({
      streamFn: (options) => llm.stream(options),
      // Resolved per call by the arbiter's deps if provided; the session
      // transport reports the provider/model it used in its own result.
      provider: prompt.provider,
      model: prompt.model,
      system: prompt.system,
      user: prompt.user,
      maxTokens: m.maxTokens,
      timeoutMs: m.timeoutMs,
      thinking: m.thinking,
      signal: opts.signal,
      log,
    })
  }
}

/** Normalize a System One response into the arbiter's `{choice, confidence, risk, reason, backend}` shape. */
function normalizeSystemone(result, prompt) {
  const wanted = prompt?.choiceQuestionId ?? 'decision'
  const answer = result?.answers?.[wanted]
  if (answer === undefined) throw new Error(`System One returned no answer for question ${JSON.stringify(wanted)}`)
  const risk = result?.answers?.risk?.choice
  return {
    choice: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    probabilities: answer.probabilities,
    risk: risk === 'low' || risk === 'medium' || risk === 'high' || risk === 'critical' ? risk : null,
    reason: `systemone ${result?.servedBy ?? ''}`.trim(),
    backend: 'systemone',
  }
}

/** Parse a strict-JSON verdict out of chat-model text. Throws when unusable (callers fail closed). */
function parseVerdictText(text) {
  let body = String(text ?? '').trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = String(fence[1] ?? '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('decision model did not return a JSON object')
  const parsed = JSON.parse(body.slice(start, end + 1))
  if (typeof parsed?.choice !== 'string') throw new Error('decision model returned no choice')
  const risk = parsed.risk
  return {
    choice: parsed.choice,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    probabilities: parsed.probabilities,
    risk: risk === 'low' || risk === 'medium' || risk === 'high' || risk === 'critical' ? risk : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    backend: 'chat',
  }
}

/** Resolve the API key from the literal, the environment, or a key file. */
async function resolveApiKey(m) {
  if (typeof m.apiKey === 'string' && m.apiKey.trim() !== '') return m.apiKey.trim()
  if (typeof m.apiKeyEnv === 'string' && m.apiKeyEnv.trim() !== '') {
    const v = process.env[m.apiKeyEnv]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  if (typeof m.apiKeyFile === 'string' && m.apiKeyFile.trim() !== '') {
    const { readFile } = await import('node:fs/promises')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const p = m.apiKeyFile.startsWith('~') ? join(homedir(), m.apiKeyFile.slice(1)) : m.apiKeyFile
    try {
      const content = await readFile(p, 'utf8')
      const line = content
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l !== '' && !l.startsWith('#') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
      if (line !== undefined) {
        const value = line.slice(line.indexOf('=') + 1).trim()
        if (value !== '') return value
      }
    } catch (error) {
      throw new Error(`could not read decision.model.apiKeyFile ${JSON.stringify(p)}: ${String(error)}`)
    }
  }
  return null
}

/**
 * Resolve the harness home directory.
 *
 * Mirrors `@deepseek-ai/dsh-home-paths`: an explicit configured path wins, then
 * `$DSH_HOME`, then `~/.dsh`. A plugin has no way to be handed the configured
 * path, so this is the best available approximation — and it is only used to
 * decide *where to put a preset*, where being wrong is recoverable (the preset
 * simply is not discovered), not a security decision.
 *
 * @returns {string} the harness home directory.
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * Render a decision verdict as a short human-readable recommendation.
 *
 * Only what the verdict actually carries is shown: a `choice`, optionally the
 * probability it was given, and the reasoning. An empty string means the verdict
 * named nothing usable, and the caller then injects no advice at all rather than
 * a helpful-looking blank.
 *
 * @param {any} verdict - the arbiter's verdict object.
 * @returns {string} a short phrase, or '' when there is nothing to say.
 */
function describeVerdict(verdict) {
  if (verdict === null || typeof verdict !== 'object') return ''
  const choice = typeof verdict.choice === 'string' ? verdict.choice.trim() : ''
  if (choice === '') return ''
  const labels = Array.isArray(verdict.selected) && verdict.selected.length > 0 ? verdict.selected.join(', ') : choice
  return `"${labels}"`
}

/** A model-facing text message stamped with this plugin's producer source. */
function textMessage(text) {
  return createUserMessage({ content: [{ type: 'text', text: String(text) }], source: PLUGIN_SOURCE })
}

/**
 * Resolve the entry config: detach any host wrappers and fill every section the
 * host did not supply from the schema defaults.
 *
 * A row that carries no `config:` at all still has to arm with working
 * defaults, and a malformed config must not take the guards down with it — so
 * this function is the single place that decides what "no usable config" means,
 * and it always returns a complete, defaults-filled tree.
 *
 * @param {unknown} raw - the entry config.
 * @param {any} log - the plugin logger.
 * @returns {any} a plain, defaults-filled config.
 */
function resolveConfig(raw, log) {
  let plain
  try {
    plain = plainConfig(raw)
  } catch (error) {
    log.error(`could not read the entry config (${String(error)}); falling back to schema defaults`)
    plain = {}
  }
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) plain = {}
  try {
    // Schemastery validates and applies defaults; this is also what catches a
    // config that is the wrong shape entirely.
    const parsed = new Config(/** @type {any} */ (plain))
    return plainConfig(parsed)
  } catch (error) {
    log.error(`entry config rejected by the schema (${String(error)}); falling back to schema defaults`)
    return plainConfig(new Config({}))
  }
}
