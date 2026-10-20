/**
 * Human-facing AIDLC slash commands.
 *
 * ## Why command text reads like a briefing
 *
 * A slash command runs against the receiving agent and **creates no model
 * message** (`@deepseek-ai/dsh-commands`). So a command that must make the
 * model *act* has exactly one channel: the text it returns. Every command below
 * therefore ends by stating, in the imperative, what the model must do next and
 * which skill section owns the protocol. A command whose text is only a status
 * dump is a dead command.
 *
 * ## Names
 *
 * `ctx.commands.register` accepts lowercase letters, digits, `_` and `-` only —
 * no colons and no dots — so the upstream `/aidlc:gate` spelling becomes
 * `/aidlc-gate`. The `aidlc` command keeps the colon-era shape reachable as a
 * dispatcher (`/aidlc gate`, `/aidlc lock-tests`) without registering a second
 * handler for each name.
 *
 * ## What a command may and may not do
 *
 * Only `aidlc-on` / `aidlc-off` write a file (the project auto-route switch,
 * through `deps.state.writeAutoRouteConfig`). Nothing here writes `state.json`,
 * a gate receipt or an artifact: those are the orchestrator's protocol steps,
 * governed by the guards and the human's verdict. In particular **no command
 * and no tool ever writes `GATE-APPROVED`** — a machine-authored approval would
 * make the audit chain worthless.
 *
 * @module dsh-aidlc/surface/commands
 */

import {
  armedModeLines,
  authoritySet,
  bandThresholdLines,
  buildDecisionPrompt,
  buildStatusReport,
  classifySafely,
  formatDecisionReport,
  formatStatusReport,
  messageOf,
  modeRows,
  normalizeArbiterResult,
  resolveModeSafely,
  rootOf,
  runDoctor,
} from './tools.js'

/** Panels that report a verdict rather than change it. */
const FIRST_LINE = 'AIDLC: this command produced text only. No model message was created — act on the instructions below.'

/** The only file any command in this module writes. */
const AUTO_ROUTE_FILE = 'docs/aidlc/config.json'

/**
 * The exact standing rules for a gate. Reused verbatim so `aidlc-gate` and the
 * skill cannot drift apart.
 *
 * @param {string} gate - `gate1` or `gate2`.
 * @param {object} [deps] - the wiring's dependency bag, for the effective gate mode.
 * @returns {string[]} the rules, one per line.
 */
export function gateRules(gate, deps) {
  const gateMode = resolveModeSafely(deps ?? {}, 'gate.approval').mode
  const authority = [...authoritySet(deps ?? {})]
  const gateLine = gateMode === 'advisory'
    ? 'This gate is `advisory` by default: the human is asked every time and the model\'s verdict is only advice. An operator can lift `gate.approval` to `triage`, in which case a confident model verdict can pass the gate and is recorded as AUTO-APPROVED with a veto window — the config validator warns loudly when they do, because a gate the automation can pass is a deliberate, load-bearing choice.'
    : gateMode === 'triage'
      ? 'THIS GATE IS ARMED FOR `triage`: a decision-model verdict that clears its band\'s bar can pass this gate, recorded as AUTO-APPROVED inside a veto window. Treat that as an operator decision you must surface, and never present a substituted gate as the human\'s own approval.'
      : 'This gate resolves to `hold`: the model is never consulted and only the human can pass it.'
  return [
    `Gate#${gate === 'gate1' ? '1' : '2'} sequence (the order is mechanically enforced; inverting it is denied):`,
    '1. Load the party-review skill and cross-review the route\'s artifact set, then write reviews/<gate>-ai.md. Dispatch the four reviewer roles (reviewer-pm / reviewer-architect / reviewer-qa / reviewer-dev) through the **subagent_reviewer** tool — NOT through `subagent`, which would silently lose the read-only guarantee. `subagent_reviewer` restricts its child to read/read_image/glob/grep/skill/todo_write, so write, edit and shell tools are absent from the reviewer\'s prompt AND refuse to execute (enforced by the tool registry, and persisted across a cold resume). It is tool-read-only, not capability-isolated: a reviewer still shares the parent\'s model route, session store and sandbox.',
    '2. Show the consolidated findings to the human and ask them to approve or reject. Use the question form; never decide for them. (If this gate is triaged and a verdict was applied, the human must still SEE that it was applied — that is what makes the veto window meaningful.)',
    `3. If they approve: FIRST append their verdict VERBATIM to decisions.md, ending with the receipt line \`GATE-APPROVED ${gate} <date>\`. YOU write that line, with your own write tool — aidlc_record_decision cannot write a receipt at all (it records the human's own words, and it refuses any text containing a receipt line). ONLY the human's own verdict is transcribed; nothing in this plugin authors the line for you, and writing it before the human has decided makes the whole audit chain worthless. For a decision-layer verdict use aidlc_record_decision with kind "auto", which produces the distinct AUTO-APPROVED/AUTO-REJECTED record.`,
    `4. THEN update state.json: gates.${gate}="approved", advance the phase, append to history (the guard denies the state write when the receipt is missing or stale).`,
    `5. If they reject: append their feedback verbatim plus \`GATE-REJECTED ${gate} <date>\`. That line VOIDS every earlier approval for this gate, so the re-review needs a NEW receipt. Set gates.${gate}="rejected" and move the phase back for revision.`,
    '6. Re-run only the roles the human named. Three failed revision rounds: escalate — continue revising, or /aidlc-archive to terminate the intent.',
    `Never automatic in code: the AUTHORITY classes (${authority.join(', ')}) are clamped, so no confidence, no timeout and no configuration can automate them.`,
    gateLine,
    'An AUTO receipt satisfies the gate-receipt rule only when `gate.approval` is armed for `triage`. It is never a human approval and never a GATE-APPROVED line — and only the human\'s own verdict is ever transcribed into that one.',
  ]
}

/**
 * The artifact set a route owes, phrased as an instruction.
 *
 * @param {'classic'|'express'} route - the effective route.
 * @returns {string} the line.
 */
export function artifactRule(route) {
  return route === 'express'
    ? 'route=express: two artifacts (prd.md, test-strategy.md — no architecture.md; fold the semantic-alignment table into an inline section of prd.md). Express trims the artifact set; it does NOT relax a gate, a receipt, the TDD lock or any guard.'
    : 'route=classic: three artifacts (prd.md, architecture.md, test-strategy.md).'
}

/**
 * Build the status panel for one workspace. Pure.
 *
 * @param {object} deps - the wiring's dependency bag.
 * @param {string} root - workspace root.
 * @param {string} [slug] - explicit intent slug.
 * @returns {Promise<{text:string, found:boolean}>} the panel.
 */
export async function statusPanel(deps, root, slug) {
  const active = slug
    ? safeCall(() => deps?.state?.loadIntent?.(root, slug) ?? null)
    : safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
  const receipts = active === null
    ? null
    : safeCall(() => deps?.ledger?.parseReceipts?.(deps?.ledger?.readLedger?.(active.intentDir) ?? '') ?? null)
  const report = buildStatusReport({ root, active, receipts, auditLines: 0, authority: [...authoritySet(deps)] })
  const lines = [formatStatusReport(report)]
  if (report.found) {
    lines.push('Next step: /aidlc-resume to reconcile state against disk, then continue the phase protocol from the aidlc skill. Never continue from memory — the disk is the source of truth.')
  }
  return { text: lines.join('\n'), found: report.found }
}

/**
 * The decision-layer panel: the audit tail, the effective mode per class, the
 * confidence bars, and what can never be automated. Pure apart from the file
 * reads under `root`.
 *
 * The bars are shown deliberately: an operator calibrating a threshold from real
 * outcomes should not have to guess which bar a given decision actually had to
 * clear.
 *
 * @param {object} deps - the wiring's dependency bag.
 * @param {string} root - workspace root.
 * @returns {Promise<string>} the panel.
 */
export async function decisionsPanel(deps, root) {
  const cfg = deps?.config?.decision ?? {}
  const authority = [...authoritySet(deps)]
  const lifted = modeRows(deps).find((r) => r.id === 'gate.approval' && r.effective === 'triage')
  const lines = [
    'AIDLC decision layer',
    `Enabled: ${cfg.enabled !== false}${deps?.decisionEnabled === false ? ' (DISARMED by config validation — every question behaves as it did before this plugin existed)' : ''}`,
    `Timeout before the model is consulted: ${cfg.timeoutMs ?? '?'} ms (0 = wait for a human indefinitely)`,
    `Fallback confidence floor: ${cfg.confidenceThreshold ?? '?'}`,
    `Below its band's bar: ${cfg.onLowConfidence ?? '?'} (never a silent pass)`,
    `Veto window for an applied triage decision: ${cfg.vetoWindowMs ?? '?'} ms`,
    `Model transport: ${cfg.model?.protocol ?? '?'}${cfg.model?.model ? ` (${cfg.model.model})` : ''}`,
    '',
    'Modes (most restrictive first): `hold` = the model is never consulted, no timeout substitution. `advisory` = the human is asked every time; the model\'s verdict is recorded and shown as advice. `triage` = the model is asked FIRST and the human only if it does not clear the bar — that is the design, not a fallback. `substitute` is an accepted alias of `triage`.',
    ...bandThresholdLines(deps),
    '',
    'Effective mode per class:',
    ...modeRows(deps).map((r) => `  - ${r.line}`),
    '',
    `AUTHORITY classes — never automatic in code, whatever the config says: ${authority.join(', ')}. This is the clamp that has not weakened; a rail wider than an operator's config is the one place the plugin refuses them.`,
  ]
  if (lifted !== undefined) {
    lines.push('WARNING: `gate.approval` is armed for `triage`. A confident model verdict can now pass a human gate, recorded as AUTO-APPROVED inside the veto window. The config validator warns about this too; the default is `advisory` (the model recommends, the human decides).')
  }
  const audit = await readAuditTail(deps, root, 10)
  if (audit.error !== null) lines.push('', `Decision audit unreadable: ${audit.error}`)
  else if (audit.lines.length === 0) lines.push('', 'Decision audit: empty (no decision has been classified yet).')
  else lines.push('', 'Decision audit (newest last):', ...audit.lines.map((l) => `  ${l}`))
  const active = safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
  const receipts = active === null ? null : safeCall(() => deps?.ledger?.parseReceipts?.(deps?.ledger?.readLedger?.(active.intentDir) ?? '') ?? null)
  const auto = Array.isArray(receipts?.auto) ? receipts.auto : []
  lines.push('', auto.length === 0
    ? 'AUTO receipts in this intent\'s decisions.md: none.'
    : `AUTO receipts in this intent's decisions.md: ${auto.length}. An AUTO receipt satisfies a gate ONLY when \`gate.approval\` is armed for \`triage\`; it is never a human approval and never a GATE-APPROVED line.`)
  lines.push('An applied triage decision is written as AUTO-APPROVED/AUTO-REJECTED and is reversible during the veto window. An escalated verdict is recorded as advisory and does not unblock.')
  return lines.join('\n')
}

/**
 * Ask the decision layer for a verdict and format it. Pure apart from the
 * arbiter call. Shared by `/aidlc-decide`-style use and by the model tool.
 *
 * @param {object} deps - the wiring's dependency bag.
 * @param {object} request - the decision request.
 * @param {object} options - `{ decisionClass, complexity, signal }`.
 * @returns {Promise<{text:string, result:object|null}>} the report.
 */
export async function decidePanel(deps, request, options = {}) {
  const classification = classifySafely(deps, request.question, {
    root: options.root ?? null,
    optionCount: request.options?.length ?? 0,
    config: deps?.config,
  })
  const decisionClass = options.decisionClass ?? classification.decisionClass
  const complexity = options.complexity ?? classification.complexity
  const resolved = resolveModeSafely(deps, decisionClass)
  if (classification.error !== null || resolved.error !== null) {
    const why = [classification.error, resolved.error].filter(Boolean).join('; ')
    return {
      text: `AIDLC decision layer is not available here (${why}). Ask the human directly — nothing was substituted.`,
      result: null,
    }
  }
  let normalized
  try {
    const raw = await deps.arbitrate({
      request,
      decisionClass,
      complexity,
      deps: {
        askHuman: () => Promise.reject(new Error('the decision layer is being asked for a verdict, not to raise a human form')),
        consultModel: async (prompt, opts = {}) => {
          if (typeof deps.consultModel !== 'function') throw new Error('no decision-model transport is configured')
          return await deps.consultModel(prompt, opts)
        },
        record: (entry) => safeCall(() => deps?.audit?.write?.(entry)),
        now: () => Date.now(),
      },
      config: deps.config,
      signal: options.signal,
    })
    normalized = normalizeArbiterResult(raw)
  } catch (error) {
    normalized = normalizeArbiterResult(null)
    normalized.note = `The decision layer threw (${messageOf(error)}). Fail-closed: keep blocking.`
  }
  return {
    text: formatDecisionReport({
      question: request.question,
      decisionClass,
      complexity,
      reasons: classification.reasons,
      mode: resolved.mode,
      neverAuto: resolved.neverAuto,
      result: normalized,
      note: normalized.note,
    }),
    result: normalized,
  }
}

/**
 * Register every AIDLC command. Synchronous; returns a per-name outcome so a
 * single duplicate name cannot take the whole surface down.
 *
 * @param {object} options
 * @param {any} options.ctx - the Cordis context (with `commands` available).
 * @param {object} options.deps - the wiring's dependency bag.
 * @returns {{ok:boolean, commands:string[], failed:string[]}} registration outcome.
 */
export function registerCommands({ ctx, deps }) {
  if (ctx?.commands === undefined || typeof ctx.commands.register !== 'function') {
    const error = 'dsh-aidlc: cannot register commands — ctx.commands.register is unavailable.'
    deps?.log?.error?.(error)
    return { ok: false, commands: [], failed: ['<registry missing>'] }
  }

  const registered = []
  const failed = []
  /** Sub-command name -> the exact handler `/aidlc-<name>` runs. No copies. */
  const table = new Map()

  /**
   * Wrap one handler with the shared admission logic: extract the raw input and
   * the workspace root, then normalize every failure into an `error` result.
   *
   * @param {string} name - the command name, for error text.
   * @param {(input:string, root:string, invocation:any, raw:string) => Promise<{kind:'success'|'error', text:string}>} run
   * @returns {(invocation:any) => Promise<{kind:'success'|'error', text:string}>} the handler.
   */
  const wrap = (name, run) => async (invocation) => {
    const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : ''
    const input = rawInput.trim()
    const root = rootOf(invocation)
    if (root === null) return { kind: /** @type {const} */ ('error'), text: `${name}: the receiving agent has no session working directory, so the intent tree cannot be located.` }
    try {
      return await run(input, root, invocation, rawInput)
    } catch (error) {
      return { kind: /** @type {const} */ ('error'), text: `${name}: ${messageOf(error)}` }
    }
  }

  /**
   * Register one command and record its handler in the dispatcher table.
   *
   * @param {string} name - command name.
   * @param {string} description - discovery description.
   * @param {string|null} hint - input hint, or null for no input.
   * @param {(input:string, root:string, invocation:any, raw:string) => Promise<{kind:'success'|'error', text:string}>} run
   */
  const add = (name, description, hint, run) => {
    const handler = wrap(name, run)
    const sub = name.replace(/^aidlc-/, '')
    if (sub !== name) table.set(sub, handler)
    try {
      ctx.commands.register({
        name,
        description,
        ...(hint === null ? {} : { input: { hint } }),
        handler,
      })
      registered.push(name)
    } catch (error) {
      failed.push(name)
      deps?.log?.warn?.(`dsh-aidlc: command ${name} was not registered: ${messageOf(error)}`)
    }
  }

  const ok = (text) => {
    const body = typeof text === 'string' && text.trim() !== '' ? text : FIRST_LINE
    return { kind: /** @type {const} */ ('success'), text: body }
  }
  const bad = (text) => ({ kind: /** @type {const} */ ('error'), text: String(text) })

  // ---------------------------------------------------------------- status
  add('aidlc-status', 'Report the active AI-DLC intent (phase, gates, ledger receipts, route, artifacts, TDD lock, units, test baseline) and the next step.', '[slug]', async (raw, root, _inv, input) => {
    const panel = await statusPanel(deps, root, input === '' ? undefined : input)
    return ok(panel.text)
  })

  // ---------------------------------------------------------------- decisions
  add('aidlc-decisions', 'Show the decision-layer state: effective mode per class, the confidence bars, the never-automatic authority classes, the decision audit, and the AUTO receipts in decisions.md.', null, async (_raw, root) => ok(await decisionsPanel(deps, root)))

  // ---------------------------------------------------------------- doctor
  add('aidlc-doctor', 'Read-only end-to-end self-check: does the decision transport actually answer, are the classes and bars what you think, is a gate armed, is the reviewer tool registered, is the audit sink writable, are the skills discoverable. Add --probe to spend one real request on a transport probe.', '[--probe]', async (_raw, root, invocation, input) => {
    const probe = /(^|\s)--probe(\s|$)/.test(input)
    const unknownArgs = input.replace(/--probe/g, '').trim()
    if (unknownArgs !== '') {
      return bad(`aidlc-doctor: unknown argument ${JSON.stringify(unknownArgs)}. The only argument is --probe (spends one real request checking that the decision transport answers).`)
    }
    // A failure inside the doctor must read as UNKNOWN, never as a pass — so even
    // the shell around it is guarded rather than allowed to throw.
    try {
      const result = await runDoctor({ deps, root, ctx: invocation?.ctx ?? ctx, probe })
      return ok(result.report)
    } catch (error) {
      return bad([
        `aidlc-doctor: the doctor itself failed (${messageOf(error)}).`,
        'This is NOT a pass. Nothing about the decision layer, the gates or the reviewers has been checked.',
      ].join('\n'))
    }
  })

  // ---------------------------------------------------------------- resume
  add('aidlc-resume', 'Resume the active AI-DLC intent from disk: reconcile state against the artifact chain, then continue the phase protocol.', '[slug]', async (raw, root, _inv, input) => {
    const active = input === ''
      ? safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
      : safeCall(() => deps?.state?.loadIntent?.(root, input) ?? null)
    if (active === null) {
      return bad(`aidlc-resume: no ${input === '' ? 'active' : `intent "${input}"`} under docs/aidlc/. Run /aidlc-status for the history, or start one with the aidlc skill's Inception protocol.`)
    }
    if (active.state?.phase === 'done' || active.state?.phase === 'archived') {
      return bad(`aidlc-resume: intent "${active.slug}" is ${active.state.phase} — a finished or terminated intent is read-only and is never resumed.`)
    }
    const panel = await statusPanel(deps, root, active.slug)
    return ok([
      panel.text,
      '',
      `MODEL: resume intent "${active.slug}" from docs/aidlc/${active.slug}/. Load the aidlc skill and follow its Resume protocol exactly:`,
      '  1. RECONCILE FIRST — compare what state.json claims against the artifacts on disk, the git log, and the decisions.md entries; print a difference table before doing anything else.',
      '  2. Then act on each difference: commit an uncommitted artifact / advance a stale phase / re-run a role / report a missing decision entry to the human.',
      '  3. In Construction, resume by unitStatus: completed units are NOT re-run; only pending ones continue.',
      '  4. Do not trust your memory of an earlier session — everything above comes from disk.',
    ].join('\n'))
  })

  // ---------------------------------------------------------------- inception
  add('aidlc-inception', 'Start an AI-DLC intent: Inception phase — confirm the route with the human, create the skeleton, then fan out the role artifacts.', '<one-line intent>', async (_raw, root, _inv, input) => {
    if (input === '') return bad('aidlc-inception: give the intent, e.g. /aidlc-inception add CSV export to the reporting service')
    return ok([
      `MODEL: start an AIDLC intent for — ${input}`,
      'Load the aidlc skill and follow its Inception protocol exactly:',
      '  1. ROUTE CONFIRMATION BEFORE ANY DIRECTORY EXISTS: propose express or classic from the size of the request and ask the human to confirm BOTH "enter the lifecycle" and the route in ONE question form. No choice or no confirmation = classic. Record the verdict, including the route, VERBATIM in decisions.md before creating the intent.',
      `  2. Only then create docs/aidlc/<kebab-slug>/ with intent.md, state.json (phase=inception, with the confirmed route) and an empty decisions.md, and commit them. Roles only ever write their own artifact file.`,
      '  3. If the intent is ambiguous, ask at most 3 key questions first; record every human verdict verbatim.',
      `  4. Fan out the roles per route — ${artifactRule('classic')} For express, drop architecture.md and fold the semantic-alignment section into prd.md.`,
      '  5. Alignment pass after the artifacts land: cross-check the AC numbers qa cited against the PRD\'s real numbers and the architect\'s semantic-alignment verbs against the PRD verbs. Send mismatches back as reference fixes only.',
      '  6. Then set phase=gate1 and tell the human to run /aidlc-gate. Gate approvals and test unlocks are NEVER automatic.',
    ].join('\n'))
  })

  // ---------------------------------------------------------------- gate
  add('aidlc-gate', 'Run the current AI-DLC review gate: cross-review, human verdict, receipt, then the state transition.', '[gate1|gate2]', async (_raw, root, _inv, input) => {
    const active = safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
    if (active === null) return bad('aidlc-gate: no active intent. Start one with /aidlc-inception, or inspect with /aidlc-status.')
    const phase = active.state?.phase
    const gates = active.state?.gates && typeof active.state.gates === 'object' ? active.state.gates : {}
    const requested = input === '' ? null : input
    if (requested !== null && requested !== 'gate1' && requested !== 'gate2') {
      return bad(`aidlc-gate: "${requested}" is not a gate. Use /aidlc-gate gate1 or /aidlc-gate gate2, or omit the argument to infer it from the phase.`)
    }
    if (phase === 'operations' || phase === 'done' || phase === 'archived') {
      return bad(`aidlc-gate: intent "${active.slug}" is past its gates (phase=${phase}). A passed gate is history and is never rewritten; reviews/ files are not re-authored.`)
    }
    // Infer the gate FIRST, then check its precondition. The inference is purely
    // phase-driven: `gate2` phase means Gate#2, everything else means Gate#1.
    const gate = requested ?? (phase === 'gate2' ? 'gate2' : 'gate1')
    if (phase === 'construction' && gate !== 'gate1') {
      return bad([
        `aidlc-gate: Gate#2 is not open for intent "${active.slug}" — gate1=${gates.gate1 ?? 'pending'} and phase=${phase}.`,
        'Gate#2 has a precondition that the guards also enforce: units complete, the regression comparison run against testBaseline, then phase=gate2 and the invocation /aidlc-gate gate2. Nothing before that.',
        'What to do now: /aidlc-resume to reconcile and see which units or checks are still open, /aidlc-construct for the Construction protocol, or /aidlc-gate gate1 if what you actually want is the design gate.',
      ].join('\n'))
    }
    const receipt = safeCall(() => deps?.ledger?.gateReceiptStatus?.(deps?.ledger?.readLedger?.(active.intentDir) ?? '', gate) ?? null)
    const lines = [
      `MODEL: run Gate#${gate === 'gate1' ? '1' : '2'} for intent "${active.slug}" (phase=${phase}, gates: gate1=${gates.gate1 ?? 'pending'}, gate2=${gates.gate2 ?? 'pending'}; ledger receipt for ${gate}: ${receipt?.state ?? 'none'}${receipt?.at ? ` at ${receipt.at}` : ''}).`,
      `Load the aidlc skill's Gate protocol and the party-review skill, then execute in this order — the order is what the guards enforce:`,
      ...gateRules(gate, deps),
    ]
    if (phase === 'inception' && gate === 'gate1') {
      lines.push('Precondition: the route\'s artifact set must be complete AND committed, and the alignment pass must have run. If it is not, set phase=gate1 only after the backlog is closed — or send the human to /aidlc-resume.')
    }
    return ok(lines.join('\n'))
  })

  // ---------------------------------------------------------------- construct
  add('aidlc-construct', 'Run the AI-DLC Construction phase: sprint planning, the test baseline, the TDD lock, parallel unit implementation, regression comparison.', null, async (_raw, root) => {
    const active = safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
    if (active === null) return bad('aidlc-construct: no active intent. Start one with /aidlc-inception.')
    if (active.state?.gates?.gate1 !== 'approved') {
      return bad(`aidlc-construct: intent "${active.slug}" has gate1=${active.state?.gates?.gate1 ?? 'pending'}. Construction artifacts are denied before Gate#1 is approved. Run /aidlc-gate first.`)
    }
    const audit = active.state?.testBaseline === undefined
      ? 'No testBaseline yet — step 0 below is mandatory and must run BEFORE any test file of this intent is written.'
      : active.state.testBaseline?.unavailable === true
        ? 'testBaseline is recorded as unavailable: no counts were invented and no comparison is claimed. Whether to proceed is the human\'s call.'
        : 'testBaseline is recorded.'
    return ok([
      `MODEL: run Construction for intent "${active.slug}". Load the aidlc skill's Construction protocol and execute in order:`,
      '  0. TEST BASELINE — run the verification command declared in plan.md and record state.testBaseline. This is a hard ordering constraint: it must happen BEFORE any test file of this intent is written, including dev\'s failing test. Unparseable or failed output is recorded as unavailable:true with null counts — NEVER fabricate 0 failures.',
      '  1. SPRINT PLANNING — split the PRD into units, write plan.md (Units table with the impact column; the "verification command" section) and units/<n>.md, and commit.',
      '  2. TDD LOCK — after dev writes and commits the failing test, arm /aidlc-lock-tests. From then on the guard denies edits to the locked test files.',
      '  3. PARALLEL IMPLEMENTATION — one lane per unit (dev / architect / tea). Update state.unitStatus[<unit>]="done" and commit per unit: the unit is the checkpoint granularity.',
      '  4. BEFORE VERIFICATION — re-run the SAME verification command and compare against testBaseline. A use case that passed in the baseline and now fails is a REGRESSION and a BLOCKER: fix it, or get a verbatim human exemption in decisions.md. Compare only within the recorded suites and exclude the intent\'s own new tests in tddLockPaths. A count-only comparison must be disclosed as such at the gate.',
      `  5. Then set phase=gate2 and tell the human to run /aidlc-gate. ${audit}`,
      'Reminder: the guards are process constraints, not a security boundary — a shell redirect walks straight past them. They stop slips, not adversaries.',
    ].join('\n'))
  })

  // ---------------------------------------------------------------- ops
  add('aidlc-ops', 'Run the AI-DLC Operations phase: runbook, monitoring and alerting, and the feedback loop into new intents.', null, async (_raw, root) => {
    const active = safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
    if (active === null) return bad('aidlc-ops: no active intent. Start one with /aidlc-inception.')
    if (active.state?.gates?.gate2 !== 'approved') {
      return bad(`aidlc-ops: intent "${active.slug}" has gate2=${active.state?.gates?.gate2 ?? 'pending'}. Operations is not reachable before Gate#2 is approved. Run /aidlc-gate first.`)
    }
    const route = active.state?.route === 'express' ? 'express' : 'classic'
    return ok([
      `MODEL: run Operations for intent "${active.slug}" (route=${route}). Load the aidlc skill's Operations protocol.`,
      '  1. Produce the monitoring / alerting / deployment-pipeline recommendations in ops-runbook.md. SLAs, thresholds and deployment windows are the human\'s to set: collect them with a question form and record the verdicts VERBATIM in decisions.md.',
      '  2. Feedback loop: production events and lessons go into a NEW intent\'s intent.md. The current intent\'s own lessons go into retro.md — a finished intent\'s original artifacts are never rewritten.',
      route === 'express'
        ? '  3. Completion: retro.md is HUMAN-OPTIONAL on an express route (decide it together with the Gate#2 approval, or omit it entirely, and record the choice verbatim). Human confirmation is still required to set phase=done.'
        : '  3. Completion: retro.md is mandatory on a classic route. It lands, the human confirms, and only then does phase become done — after which the intent is no longer active.',
    ].join('\n'))
  })

  // ---------------------------------------------------------------- lock/unlock
  add('aidlc-lock-tests', 'Arm the TDD lock: the committed failing tests become contracts and edits to them are denied until a human-approved unlock.', null, async (_raw, root) => {
    const active = safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
    if (active === null) return bad('aidlc-lock-tests: no active intent.')
    const existing = Array.isArray(active.state?.tddLockPaths) ? active.state.tddLockPaths : []
    return ok([
      `MODEL: arm the TDD lock for intent "${active.slug}". Load the aidlc skill's Construction protocol ("TDD lock") and execute:`,
      '  1. Precondition: the intent\'s failing tests are COMMITTED. Check the git log for the test-file commit; if it is missing, commit it first.',
      '  2. Derive the locked paths from that commit (git show --name-only <hash>) and UNION them with the existing state.tddLockPaths — never replace it. The scope only ever grows: re-arming must not drop the protection of an earlier unit. Paths may be relative or absolute; the guard matches by suffix, case-insensitively.',
      `  3. Update state.json: tddLock=true, clear tddLockOverride, and append a history entry naming the arming time and the test commit. Current locked paths on disk: ${existing.length === 0 ? '(none — an empty or missing list means EVERY test file in the repository is locked)' : existing.join(', ')}.`,
      '  4. Report the arming result and the protected path list to the human.',
      'After arming, the guard DENIES edits to the locked test files. If the contract itself is wrong, the only way through is /aidlc-unlock-tests <reason> — with a human decision, recorded verbatim.',
    ].join('\n'))
  })

  add('aidlc-unlock-tests', 'Human-approved unlock of the TDD lock: the reason is recorded in decisions.md before any test edit is allowed.', '<why the contract must change>', async (_raw, root, _inv, input) => {
    const active = safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
    if (active === null) return bad('aidlc-unlock-tests: no active intent.')
    if (input === '') {
      return bad('aidlc-unlock-tests: a reason is required — this is an exception to "the tests are the contract" and it must be recorded. Ask the human why the contract needs to change, then run /aidlc-unlock-tests <their reason>. Do not invent one.')
    }
    return ok([
      `MODEL: record a HUMAN-approved unlock of the TDD lock for intent "${active.slug}". The reason given is:`,
      `  ${input}`,
      'Load the aidlc skill and execute:',
      '  1. Append the decision VERBATIM to decisions.md — date, an UNLOCK-TESTS marker, and the human\'s own reason text, character for character. The ledger is append-only: read the whole file and write it back plus the addition; an in-place Edit is denied by the guard.',
      '  2. Set state.json tddLockOverride = { "by": "human", "at": "<date>", "reason": "<the human\'s reason>" } and KEEP tddLock = true. The override is what lets test edits through.',
      '  3. Report the override and remind the human: re-arm with /aidlc-lock-tests once the contract is fixed (re-arming clears the override). While the unlock window is open every test edit is reminded to re-lock — leaving it open for long means the contract is running naked.',
      `  4. AUTHORITY class, never automatic: \`test.unlock\` is clamped in code (${[...authoritySet(deps)].join(', ')} are all clamped), so no confidence, no timeout and no configuration can unlock the TDD lock — the mode can only ever come back \`hold\`. A decision-model verdict here is not a substitute for a human decision; it is a recommendation to one.`,
    ].join('\n'))
  })

  // ---------------------------------------------------------------- archive
  add('aidlc-archive', 'Terminate an AI-DLC intent with a human-decided reason: archived, never deleted.', '<slug> <why terminating>', async (raw, root, _inv, input) => {
    const parts = input.split(/\s+/).filter(Boolean)
    const slug = parts[0] ?? ''
    const why = parts.slice(1).join(' ')
    if (slug === '') {
      return bad('aidlc-archive: give the slug and the reason, e.g. /aidlc-archive hotel-booking-api requirements cancelled. If the reason is missing, ask the human for it — never invent one.')
    }
    const intent = safeCall(() => deps?.state?.loadIntent?.(root, slug) ?? null)
    if (intent === null) return bad(`aidlc-archive: no intent "${slug}" under docs/aidlc/.`)
    if (intent.state?.phase === 'archived') return bad(`aidlc-archive: intent "${slug}" is already archived.`)
    if (why === '') {
      return bad(`aidlc-archive: intent "${slug}" found, but the termination reason is missing. Ask the human why it is being terminated, then re-run with their words — the reason is recorded verbatim and must never be invented.`)
    }
    return ok([
      `MODEL: terminate intent "${slug}" (current phase: ${intent.state?.phase ?? 'unknown'}). The human's reason is:`,
      `  ${why}`,
      'Load the aidlc skill\'s Termination protocol (§9) and execute:',
      '  1. Append the reason VERBATIM to that intent\'s decisions.md, ending with an `ARCHIVED <date>` marker line. Append-only: read the whole file, write it back plus the addition.',
      '  2. Update state.json: phase="archived", and append a history entry whose why cites the termination decision in decisions.md.',
      '  3. Report the archived slug and the reason summary, and state clearly that the intent has left the active slot (no longer injected, no longer selected by /aidlc-resume) while the artifact chain and decisions.md stay exactly as they are for audit. Nothing historical is deleted.',
      '  archived means terminated mid-flight; done means delivered. They are different terminal states and both leave the active slot.',
    ].join('\n'))
  })

  // ---------------------------------------------------------------- on/off
  add('aidlc-on', 'Turn on AIDLC auto-route: plain-language requests enter the lifecycle (gate approvals and every guard are unaffected).', null, async (_raw, root) => {
    const written = await writeSwitch(deps, root, true)
    if (!written.ok) return bad(`aidlc-on: could not write ${AUTO_ROUTE_FILE}: ${written.message}`)
    const active = safeCall(() => deps?.state?.findActiveIntent?.(root) ?? null)
    return ok([
      written.already
        ? `AIDLC auto-route was already ON — no file was rewritten (${AUTO_ROUTE_FILE}).`
        : `AIDLC auto-route is now ON (${AUTO_ROUTE_FILE}, keeping every other key, with a fresh updatedAt).`,
      'Three things to tell the human:',
      '  1. ON — plain-language development requests now enter the lifecycle without typing a command. Before anything is created you show the one-line intent plus a 3–6 bullet split preview and ask for confirmation; a possibly out-of-scope input during a lifecycle gets the three-way choice (extend this intent / park it in the backlog / go outside the process with a written record); and an intent that entered this way still gets its unit split confirmed by a human before development starts.',
      `  2. The gates do not change BY DEFAULT — \`gate.approval\` is \`advisory\`, so Gate#1 and Gate#2 are the human's decision every time. The AUTHORITY classes (${[...authoritySet(deps)].join(', ')}) are clamped in code and can never be automated at all. An operator CAN lift \`gate.approval\` to \`triage\`; that is a deliberate, load-bearing choice the config validator warns about, and it is not the default.`,
      '  3. The guards are unaffected by this switch — path guard, construction gate, TDD lock, overwrite integrity and AC coverage stay in force in both states. The switch controls routing, never protection. It is also not the same thing as an intent\'s `route` field (classic/express): the switch governs whether plain language is routed, `route` governs how much process an intent runs.',
      active === null
        ? 'No active intent right now.'
        : `Active intent: ${active.slug}@${active.state?.phase ?? 'unknown'} — /aidlc-resume continues it, /aidlc-status inspects it.`,
    ].join('\n'))
  })

  add('aidlc-off', 'Turn off AIDLC auto-route: back to explicit /aidlc-* commands only (intents stay resumable and every guard stays on).', null, async (_raw, root) => {
    const written = await writeSwitch(deps, root, false)
    if (!written.ok) return bad(`aidlc-off: could not write ${AUTO_ROUTE_FILE}: ${written.message}`)
    return ok([
      written.already
        ? `AIDLC auto-route was already OFF — no file was rewritten (${AUTO_ROUTE_FILE}).`
        : `AIDLC auto-route is now OFF (${AUTO_ROUTE_FILE}, keeping every other key, with a fresh updatedAt).`,
      'Three things to tell the human:',
      '  1. OFF — back to explicit /aidlc-* commands; ordinary messages are no longer routed into the process.',
      '  2. Nothing else changed: the active intent\'s state and artifacts are untouched and /aidlc-resume still continues it. The guards (path guard, construction gate, TDD lock, overwrite integrity, AC coverage) are STILL in force — turning routing off is not turning protection off.',
      '  3. To disable the plugin entirely, including the guards, the plugin must be disabled or uninstalled in the client and the session restarted. Nothing this command does stops a guard.',
    ].join('\n'))
  })

  // ---------------------------------------------------------------- dispatcher
  add('aidlc', `AIDLC dispatcher: /aidlc <subcommand> [args]. Subcommands: ${[...table.keys()].join(', ')}.`, '<subcommand> [args]', async (input, root, invocation) => {
    const parts = input.split(/\s+/).filter(Boolean)
    const sub = parts.shift() ?? ''
    const names = [...table.keys()]
    if (sub === '') {
      return bad(`aidlc: which subcommand? Available: ${names.join(', ')}. Example: /aidlc gate gate2`)
    }
    const target = table.get(sub)
    if (target === undefined) {
      return bad(`aidlc: unknown subcommand "${sub}". Available: ${names.join(', ')}.`)
    }
    return await target({ ...invocation, rawInput: parts.join(' ') })
  })

  return { ok: failed.length === 0, commands: registered, failed }
}

/**
 * Write the project auto-route switch through the wiring's state module.
 *
 * @param {object} deps - the wiring's dependency bag.
 * @param {string} root - workspace root.
 * @param {boolean} on - the target state.
 * @returns {Promise<{ok:boolean, already:boolean, message:string}>} the outcome.
 */
async function writeSwitch(deps, root, on) {
  const read = safeCall(() => deps?.state?.readAutoRouteConfig?.(root) ?? null)
  if (read !== null && read.exists === true && read.on === on) return { ok: true, already: true, message: '' }
  if (typeof deps?.state?.writeAutoRouteConfig !== 'function') {
    return { ok: false, already: false, message: 'deps.state.writeAutoRouteConfig is unavailable in this composition' }
  }
  const result = safeCall(() => deps.state.writeAutoRouteConfig(root, on))
  if (result === null || result?.ok !== true) {
    return { ok: false, already: false, message: result?.message ?? 'the state module rejected the write' }
  }
  return { ok: true, already: false, message: '' }
}

/**
 * Read at most `limit` trailing non-empty lines of the decision audit JSONL.
 *
 * @param {object} deps - the wiring's dependency bag.
 * @param {string} root - workspace root.
 * @param {number} limit - maximum lines.
 * @returns {Promise<{lines:string[], error:string|null}>} the tail.
 */
async function readAuditTail(deps, root, limit) {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.join(root, deps?.config?.audit?.path ?? 'docs/aidlc/decision-audit.jsonl')
    if (!fs.existsSync(file)) return { lines: [], error: null }
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    return { lines: lines.slice(-limit), error: null }
  } catch (error) {
    return { lines: [], error: messageOf(error) }
  }
}

/**
 * Run a function and swallow a throw into `null`.
 *
 * @template T
 * @param {() => T} fn - the function.
 * @returns {T|null} its result, or null.
 */
function safeCall(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

export { buildDecisionPrompt }
