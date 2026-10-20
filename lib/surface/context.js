/**
 * Context injection for the AIDLC surface — the two pure string builders the
 * harness wiring (`lib/index.js`) feeds to `agent.inject()` on session start
 * and on each submitted prompt.
 *
 * Purity is a contract, not a style preference: this module imports nothing
 * from `@deepseek-ai/*` and needs no harness runtime, so `node --test` can
 * exercise every branch against a fixture `docs/aidlc` tree. It talks to the
 * filesystem directly and synchronously, exactly like the ZCode hooks it
 * ports (`session-context.mjs`, `auto-route.mjs`), so a failure anywhere
 * degrades to "inject nothing" rather than throwing into the agent loop.
 *
 * Two behaviours are ported byte-for-byte because they were paid for in real
 * sessions:
 *
 * 1. **The auto-route toggle detector** — a short phrase such as `aidlc on`
 *    must switch the project switch even while the feature is OFF, while a
 *    long paragraph that merely mentions the words must not. Hence the 80-char
 *    cap and the deliberately conservative separator/word classes.
 * 2. **The three-state route echo** — field absent/null emits no route text at
 *    all (legacy intents keep byte-identical output); `classic`/`express` echo
 *    verbatim; anything else echoes the raw value with `(invalid→classic)`, so
 *    a typo is visible and its fail-safe meaning is stated. The injector never
 *    branches on this value.
 *
 * Both builders return `null` — never `''` — when they have nothing to add, so
 * the wiring can skip injection entirely and leave the request prefix
 * byte-identical for sessions that never opted in.
 *
 * @module dsh-aidlc/surface/context
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** How many trailing `decisions.md` lines the warm-up shows. */
const DECISION_TAIL_LINES = 15

/** Hard character cap on the injected decision tail. */
const DECISION_TAIL_CHARS = 2_000

/** Toggle phrases are short. Anything longer is prose that merely mentions the words. */
const TOGGLE_MAX_CHARS = 80

/** How many trailing decision-audit lines the prompt injector surfaces. */
const AUDIT_TAIL_LINES = 3

/** An intent in either of these terminal phases is never "active". */
const TERMINAL_PHASES = new Set(['done', 'archived'])

/** Artifact set per route — `express` trims the classic set, it does not relax it. */
const ROUTE_ARTIFACTS = {
  classic: ['prd.md', 'architecture.md', 'test-strategy.md'],
  express: ['prd.md', 'test-strategy.md'],
}

/**
 * @typedef {object} Intent
 * @property {string} slug - directory name under `docs/aidlc/`.
 * @property {string} statePath - absolute path to the intent's `state.json`.
 * @property {string} intentDir - absolute path to the intent directory.
 * @property {object} state - parsed `state.json`.
 * @property {string|null} decisionsPath - absolute path to `decisions.md`, when present.
 */

/**
 * @typedef {object} AutoRouteSwitch
 * @property {boolean} on - effective switch state.
 * @property {boolean} exists - true when the project has ever configured it.
 * @property {'mode'|'project'|'entry'|'default'} source - where `on` came from.
 * @property {boolean|null} overrode - when `source` is `mode`, the project file's
 *   own value that the mode overruled (null when there was nothing to overrule).
 */

/**
 * A defect in a read path is never fatal: context injection is an optional
 * convenience, and an unreadable file must not break the agent loop.
 *
 * @param {unknown} _error - ignored.
 * @returns {null} always.
 */
function swallow(_error) {
  return null
}

/**
 * Read and parse one JSON file.
 *
 * @param {string} file - absolute path.
 * @returns {object|null} parsed object, or null when absent/corrupt/non-object.
 */
function readJson(file) {
  try {
    if (!existsSync(file)) return null
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Read one UTF-8 text file.
 *
 * @param {string} file - absolute path.
 * @returns {string|null} contents, or null when unreadable.
 */
function readText(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

/**
 * Rank one candidate intent directory.
 *
 * The authoritative key is the state's own `updatedAt` (a deliberate
 * correction carried over from the original: file mtime diverges from the
 * declared semantics). mtime is only the fallback when `updatedAt` is
 * missing or unparseable.
 *
 * @param {string} base - `docs/aidlc` directory.
 * @param {string} slug - intent directory name.
 * @returns {{slug:string,statePath:string,intentDir:string,state:object,key:number}|null} candidate, or null.
 */
function rankIntent(base, slug) {
  const intentDir = join(base, slug)
  const statePath = join(intentDir, 'state.json')
  try {
    if (!existsSync(statePath)) return null
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return null
    if (typeof state.phase === 'string' && TERMINAL_PHASES.has(state.phase)) return null
    const declared = Date.parse(String(state.updatedAt ?? ''))
    const key = Number.isFinite(declared) ? declared : statSync(statePath).mtimeMs
    return { slug, statePath, intentDir, state, key }
  } catch {
    return null
  }
}

/**
 * Find the active intent: the newest `docs/aidlc/&lt;slug&gt;/state.json` that is not
 * `done` or `archived`. Per-intent failures are skipped, never fatal.
 *
 * Mirrors `findActiveIntent` in `lib/aidlc/state.js` (same ranking, same
 * terminal-phase set) and the ZCode hook's `findActiveIntent`.
 *
 * @param {string} root - workspace root.
 * @returns {Intent|null} the active intent, or null.
 */
function findActiveIntent(root) {
  const base = join(root, 'docs', 'aidlc')
  if (!existsSync(base)) return null
  let names
  try {
    names = readdirSync(base)
  } catch (error) {
    return swallow(error)
  }
  let best = null
  for (const name of names) {
    const candidate = rankIntent(base, name)
    if (candidate === null) continue
    if (best === null || candidate.key > best.key) best = candidate
  }
  if (best === null) return null
  const decisionsPath = join(best.intentDir, 'decisions.md')
  return {
    slug: best.slug,
    statePath: best.statePath,
    intentDir: best.intentDir,
    state: best.state,
    decisionsPath: existsSync(decisionsPath) ? decisionsPath : null,
  }
}

/**
 * Resolve the effective auto-route switch.
 *
 * Precedence, in this order:
 * 1. the per-project `docs/aidlc/config.json` when it exists **and parses** —
 *    the repository-travelling switch always wins;
 * 2. the entry `config.autoRouting` when the file is absent or malformed;
 * 3. `false`.
 *
 * A malformed file is treated as "the feature was never configured" only when
 * the entry config is also false. When the entry config says `true`, honouring
 * it is the opt-in direction and a broken project file must not silently
 * disable a feature the deployment turned on.
 *
 * `exists` distinguishes "never configured anywhere" (stay silent) from
 * "explicitly off" (echo the state) — the distinction the original made so a
 * project that never touched the feature sees no extra noise.
 *
 * **Precedence, most specific first:**
 *
 * 1. `autoRouteOverride` — an explicit, later act by the caller. The agent-preset
 *    mode supplies it, and it outranks the project file: *choosing a mode for this
 *    session is a more specific and later act than a repository default.* Without
 *    this, a repo whose `docs/aidlc/config.json` says `autoRouting:false` would
 *    show the mode's banner while silently having no routing contract — the banner
 *    would promise routing the session does not have.
 * 2. the project file `docs/aidlc/config.json` when it exists and parses — it still
 *    governs every session that is **not** in the mode;
 * 3. the entry `config.autoRouting`;
 * 4. `false`.
 *
 * @param {string} root - workspace root.
 * @param {object|undefined|null} config - the resolved plugin config, if any.
 * @param {boolean|undefined} override - the caller's explicit decision, if any.
 * @returns {AutoRouteSwitch} the switch.
 */
function resolveAutoRoute(root, config, override) {
  const file = join(root, 'docs', 'aidlc', 'config.json')
  const raw = readText(file)
  if (override === true || override === false) {
    const cfg = raw === null ? null : readJson(file)
    const fileOn = cfg !== null && typeof cfg.autoRouting === 'boolean' ? cfg.autoRouting : null
    return { on: override, exists: true, source: 'mode', overrode: fileOn !== null && fileOn !== override ? fileOn : null }
  }
  if (raw !== null) {
    const cfg = readJson(file)
    if (cfg !== null && typeof cfg.autoRouting === 'boolean') {
      return { on: cfg.autoRouting, exists: true, source: 'project', overrode: null }
    }
  }
  const entry = config?.autoRouting === true
  if (entry) return { on: true, exists: true, source: 'entry', overrode: null }
  return { on: false, exists: raw !== null || config?.autoRouting === false, source: raw !== null ? 'project' : 'default', overrode: null }
}

/**
 * Detect an auto-route toggle request in a user prompt.
 *
 * Deterministic on purpose: it runs even while the feature is OFF (otherwise
 * `aidlc on` could never be typed), and it only *recognises* the request — the
 * model still decides whether the sentence really is a toggle and performs the
 * write.
 *
 * Conservative by construction:
 * - prompts longer than {@link TOGGLE_MAX_CHARS} are never toggles;
 * - the separator class absorbs `aidlc: on`, `aidlc，开启`;
 * - the trailing `(?:\b|$)` is required because `\b` never matches after a CJK
 *   character (`「…自动路由」` ends on a non-word char, so `$` covers CJK
 *   endings and `\b` covers ASCII ones).
 *
 * @param {string} prompt - the raw user message.
 * @returns {'on'|'off'|null} the requested target, or null when not a toggle.
 */
export function detectAutoRouteToggle(prompt) {
  const p = String(prompt ?? '').trim()
  if (!p || p.length > TOGGLE_MAX_CHARS) return null
  const sep = '[\\s:：,，]*'
  const word = '(?:aidlc|自动路由|auto[\\s-]?route)'
  if (
    new RegExp(`(?:^|\\b)aidlc\\b${sep}on(?:\\b|$)`, 'i').test(p) ||
    new RegExp(`(?:^|[\\s:：,，])开启${sep}${word}(?:\\b|$)`, 'i').test(p) ||
    new RegExp(`(?:^|\\b)aidlc\\b${sep}开启`, 'i').test(p)
  ) {
    return 'on'
  }
  if (
    new RegExp(`(?:^|\\b)aidlc\\b${sep}off(?:\\b|$)`, 'i').test(p) ||
    new RegExp(`(?:^|[\\s:：,，])关闭${sep}${word}(?:\\b|$)`, 'i').test(p) ||
    new RegExp(`(?:^|\\b)aidlc\\b${sep}关闭`, 'i').test(p)
  ) {
    return 'off'
  }
  return null
}

/**
 * The three-state route echo. Read-only: the injector never branches on the
 * value, it only reports it.
 *
 * - `undefined` / `null` → `null` (no line at all; legacy intents keep their
 *   exact previous output);
 * - `'classic'` / `'express'` → `route=<value>` verbatim;
 * - anything else → `route=<raw value>(invalid→classic)`, so the typo stays
 *   observable while its effective fail-safe meaning is stated.
 *
 * @param {object|null|undefined} state - the intent state.
 * @returns {string|null} the echo line, or null when the field is absent.
 */
export function routeEcho(state) {
  const v = state?.route
  if (v === undefined || v === null) return null
  if (v === 'express' || v === 'classic') return `route=${v}`
  return `route=${String(v)}(invalid→classic)`
}

/**
 * The artifacts a route owes. Absent or invalid routes fail safe to the full
 * classic set.
 *
 * @param {object|null|undefined} state - the intent state.
 * @returns {{route:string, artifacts:string[]}} the effective route and its expected artifacts.
 */
export function expectedArtifacts(state) {
  const raw = state?.route
  const route = raw === 'express' || raw === 'classic' ? raw : 'classic'
  return { route, artifacts: [...ROUTE_ARTIFACTS[route]] }
}

/**
 * The one-line decision-layer briefing shared by both injectors, so the two
 * contexts cannot drift.
 *
 * The wording of the first two statements is load-bearing. `hold`/`advisory`
 * are the defaults, so the honest description of a timeout is "you get an
 * advisory verdict and the pipeline stays blocked" — NOT "the model decides if
 * you do not answer". Substitution exists, but it is opt-in per decision class
 * and structurally unavailable to the two classes that must never be
 * automated.
 *
 * @returns {string} the briefing, newline-separated.
 */
function decisionLayerBrief() {
  return [
    'Decision layer (triage-first): the decision model is asked FIRST, and the human only when the model does not clear its bar. That is the design, not a fallback — a question the model can call at 90% should not interrupt a human at all.',
    "Confidence bars, by how hard the question looked: trivial (C0/C1) 0.60, simple (C2) 0.85, complex (C3) 0.95. Complexity RAISES the bar; it does not forbid automation. A verdict at or above its band's bar is applied, recorded as `AUTO-APPROVED`/`AUTO-REJECTED`, and reversible during the veto window; below the bar it ESCALATES to the human carrying the model's recommendation, and the lifecycle stays blocked until they answer.",
    'Authority classes — never automatic in code, whatever the config says: `test.unlock`, `test.baseline`, `security.exception`, `irreversible.operation`, `policy.change`, `untrusted.authorization`. No confidence, no timeout and no configuration can automate them.',
    "Gate approvals (`gate.approval`) default to `advisory`: the human decides every gate and the model only pre-digests. An operator may lift that to `triage`, which is a deliberate, warned-about choice — so check the mode before assuming who decides, and never present an applied verdict as the human's own decision.",
  ].join('\n')
}

/**
 * Tail of `decisions.md` — the prior human verdicts must actually be *seen*
 * before the model acts again, not merely referenced by path.
 *
 * @param {string|null} decisionsPath - absolute path, or null.
 * @returns {string} the tail block, or the "no ledger yet" line.
 */
function decisionTail(decisionsPath) {
  const text = decisionsPath === null ? null : readText(decisionsPath)
  if (text === null) return 'No decisions.md yet. Create it with the intent skeleton before the first gate.'
  const tail = text.split('\n').slice(-DECISION_TAIL_LINES).join('\n').trim()
  if (!tail) return 'decisions.md exists but is empty. Human verdicts go here, verbatim, before any state advances.'
  return `decisions.md tail (human verdicts — binding, follow them):\n${clip(tail, DECISION_TAIL_CHARS)}`
}

/**
 * Clip a block to a character budget, saying so rather than pretending.
 *
 * @param {string} text - the block.
 * @param {number} max - maximum characters.
 * @returns {string} the block, possibly clipped with a marker.
 */
function clip(text, max) {
  if (text.length <= max) return text
  return `…(clipped, showing last ${max} chars)\n${text.slice(-max)}`
}

/**
 * Tail of the decision audit JSONL, reduced to compact one-line summaries.
 * Shown only when the file exists; a malformed line is skipped, never thrown.
 *
 * @param {string} root - workspace root.
 * @returns {string[]} zero or more summary lines.
 */
function decisionAuditSummary(root) {
  const file = join(root, 'docs', 'aidlc', 'decision-audit.jsonl')
  const text = readText(file)
  if (text === null) return []
  const lines = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const parts = [
      String(entry.at ?? '?'),
      String(entry.decisionClass ?? entry.class ?? '?'),
      String(entry.source ?? '?'),
      `substituted=${entry.substituted === true}`,
      entry.confidence === undefined || entry.confidence === null ? 'conf=?' : `conf=${entry.confidence}`,
    ]
    if (entry.reason) parts.push(`reason=${String(entry.reason).slice(0, 160)}`)
    lines.push(parts.join(' '))
  }
  return lines.slice(-AUDIT_TAIL_LINES)
}

/**
 * The AIDLC-mode lifecycle contract, as a **named system-prompt section**.
 *
 * This is the single source of truth for what the mode means. It replaces the
 * three copies that used to exist (the preset persona, the session-start banner,
 * and the routing contract below), because the same instructions in three places
 * drift — and a drifted instruction is one an agent follows two ways depending on
 * which copy it read last.
 *
 * The plugin registers it per agent through `agent.ctx.inject(['systemPrompt'], …)`
 * with `name: 'aidlc:lifecycle'` and `order: 550`, only while the session's
 * `agentPreset` projection is `aidlc`. See `lib/index.js`.
 *
 * Deliberately static: the prompt is assembled per request, and a section whose
 * text changes without a logged reason is request-cache instability.
 *
 * The last bullet is the one an agent gets wrong if it is not stated: triage-first
 * applies to *judgment* decisions, while the two gates default to human approval.
 */
export const AIDLC_LIFECYCLE_SECTION = 'aidlc:lifecycle'

/** The order that places this section after the persona (0) and before plan policy (500). */
export const AIDLC_LIFECYCLE_ORDER = 550

/** The text of the lifecycle section. Static by design; see above. */
export const AIDLC_LIFECYCLE_TEXT = [
  'AI-DLC MODE IS ACTIVE for this session. The AI-DLC lifecycle governs how you deliver work here.',
  '',
  '- When the user describes something to build or change, treat it as an intent and BEGIN it — load the `aidlc` skill and run its entry protocol (A1). Do not wait to be asked for a command, and do not answer a build-shaped request as though it were an ordinary question.',
  '- The decision model is consulted FIRST, and a human only when it is not confident enough. That is the design, not a fallback: a question the model can answer at high confidence must not interrupt a human.',
  '- The two gates are the exception: `gate.approval` defaults to human approval, so the human decides every gate and the model only pre-digests. Do not treat a gate as something the layer may pass unless `/aidlc-decisions` shows it armed for triage — and if it is armed, surface every applied verdict to the human with its confidence and veto window.',
  '- Every applied verdict is recorded in `decisions.md` as an AUTO receipt and is reversible during its veto window. Never present an applied verdict as the human\'s own decision.',
  '- The guards are unaffected by the mode: they are process constraints, not a security boundary, and they stay in force exactly as the skill describes.',
].join('\n')

/**
 * Session-start context: the active intent's warm-up summary plus the tail of
 * `decisions.md`, so a resumed session starts from what is on disk rather than
 * from what the model remembers.
 *
 * @param {object} options
 * @param {string} options.root - workspace root (the session's cwd).
 * @param {object} [options.config] - resolved plugin config (entry-level fallback).
 * @param {boolean} [options.autoRouteOverride] - the caller's explicit switch decision
 *   (the mode supplies `true`); outranks the project file.
 * @returns {string|null} the injected text, or null when there is nothing to say.
 */
export function sessionStartContext({ root, config, autoRouteOverride }) {
  if (typeof root !== 'string' || root === '') return null
  const cfg = resolveAutoRoute(root, config, autoRouteOverride)
  const active = findActiveIntent(root)

  if (active === null) {
    // Historically fully silent. With auto-route ON, one line keeps a fresh
    // session aware the feature exists before the first intent is created.
    if (!cfg.on) return null
    return 'AIDLC auto-route: ON, no active intent. When the user states a development need in plain language, show the one-line intent + a 3–6 bullet split preview and ask for confirmation BEFORE creating any directory (aidlc skill §3, "Auto-Route entry"). Turn it off with /aidlc-off.'
  }

  const s = active.state
  const gates = s.gates && typeof s.gates === 'object' ? s.gates : {}
  const lines = [
    `AIDLC active intent: ${active.slug} (phase: ${s.phase ?? 'unknown'})`,
    `Gates: gate1=${gates.gate1 ?? 'pending'}, gate2=${gates.gate2 ?? 'pending'}${s.tddLock ? ', TDD-LOCK=on' : ''}${s.tddLockOverride ? ', TDD-OVERRIDE=on' : ''}`,
  ]

  const echo = routeEcho(s)
  if (echo !== null) {
    lines.push(echo)
    const { route, artifacts } = expectedArtifacts(s)
    const note = route === 'express'
      ? 'Express trims the artifact set; it does NOT relax a gate, a receipt, the TDD lock or any guard.'
      : 'Classic requires the full artifact set.'
    lines.push(`Expected artifacts (${route}): ${artifacts.join(', ')}. ${note}`)
  }

  if (cfg.exists) {
    if (cfg.source === 'mode') {
      // Truthful, not confident: say where the switch came from AND what it
      // overruled, so an agent or human reading this can see which one is in force.
      lines.push(`Auto-route: ${cfg.on ? 'ON' : 'OFF'} (forced by the AIDLC mode for this session; ${cfg.overrode === null ? 'no project setting was overruled' : `docs/aidlc/config.json says ${cfg.overrode ? 'on' : 'off'} and the mode overrules it, because choosing a mode is a more specific and later act than a repository default`}. Plain-language requests ${cfg.on ? 'enter' : 'do NOT enter'} the lifecycle; explicit /aidlc-* commands always win; the guards are unaffected either way)`)
    } else {
      const origin = cfg.source === 'entry' ? 'entry config' : 'docs/aidlc/config.json'
      lines.push(cfg.on
        ? `Auto-route: ON (from ${origin}; plain-language requests enter the lifecycle, explicit /aidlc-* commands win, and the guards are unaffected by this switch)`
        : `Auto-route: OFF (from ${origin}; /aidlc-on enables plain-language routing, and the guards are unaffected by this switch)`)
    }
  }

  const us = s.unitStatus
  if (us && typeof us === 'object' && Object.keys(us).length > 0) {
    const ids = Object.keys(us)
    const pending = ids.filter((id) => us[id] !== 'done')
    lines.push(`Units: ${ids.length - pending.length}/${ids.length} done${pending.length ? `; pending: ${pending.join(', ')}` : ''}`)
  }

  const baseline = s.testBaseline
  if (baseline && typeof baseline === 'object' && baseline.unavailable === true) {
    lines.push('Test baseline: UNAVAILABLE (recorded as unavailable, no counts invented). Deliverable conclusions must say "no baseline to compare against"; whether to proceed is the human\'s call.')
  } else if (baseline && typeof baseline === 'object') {
    lines.push(`Test baseline: recorded ${baseline.recordedAt ?? '?'} — command: ${String(baseline.command ?? '?')}`)
  } else {
    lines.push('Test baseline: none (verification degrades to "the verification command passed").')
  }

  lines.push(decisionLayerBrief())
  const audit = decisionAuditSummary(root)
  if (audit.length > 0) lines.push(`Recent decision-audit entries (an advisory verdict never unblocks):\n${audit.join('\n')}`)

  lines.push(decisionTail(active.decisionsPath))
  lines.push('Continue with /aidlc-resume (reconcile state vs disk first) or inspect with /aidlc-status.')
  return lines.join('\n')
}

/**
 * The routing contract injected when a prompt looks like a toggle request.
 *
 * @param {'on'|'off'} target - the requested state.
 * @param {AutoRouteSwitch} cfg - the effective switch.
 * @returns {string} the contract text.
 */
function toggleContract(target, cfg) {
  const current = cfg.on ? 'on' : 'off'
  return [
    `[AIDLC switch request] AUTOROUTE-TARGET=${target}, AUTOROUTE-CURRENT=${current} (project file docs/aidlc/config.json; entry config is the fallback).`,
    'First decide whether this sentence really is a toggle. If it is a question or a discussion (e.g. "what happens once it is on"), only explain — do not touch any file.',
    `If it is a toggle: run /aidlc-on or /aidlc-off, which perform the same write (keep every other key in docs/aidlc/config.json, set "autoRouting": ${target === 'on'} and "updatedAt": <current ISO time>). If it is already in the target state, echo the confirmation and do not rewrite the file.`,
    'Echo: ON = plain-language development requests enter the AIDLC lifecycle (entry confirmation, split confirmation, out-of-scope three-way choice — aidlc skill §3, "Auto-Route entry"). Gate approvals and test unlocks are NEVER automatic in either state. OFF = explicit /aidlc-* commands only. In BOTH states the guards (path guard, construction gate, TDD lock, overwrite integrity, AC coverage) stay in force — the switch controls routing, never protection.',
  ].join('\n')
}

/**
 * Prompt-routing context: the auto-route contract for one submitted message.
 *
 * Emits the switch contract when the prompt looks like a toggle request (even
 * while OFF — otherwise the feature could never be turned on), and the routing
 * contract only while auto-route is ON. Returns null when there is nothing to
 * inject, which is the default for every project that never opted in.
 *
 * @param {object} options
 * @param {string} options.root - workspace root (the session's cwd).
 * @param {string} options.prompt - the submitted user message.
 * @param {object} [options.config] - resolved plugin config (entry-level fallback).
 * @returns {string|null} the injected text, or null when there is nothing to say.
 */
export function promptRoutingContext({ root, prompt, config, autoRouteOverride }) {
  if (typeof root !== 'string' || root === '') return null
  const cfg = resolveAutoRoute(root, config, autoRouteOverride)
  const toggle = detectAutoRouteToggle(prompt)
  const blocks = []
  if (toggle !== null) blocks.push(toggleContract(toggle, cfg))
  if (cfg.on) blocks.push(routeContract(findActiveIntent(root)))
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

/**
 * The auto-route contract itself: what this message is, and the ordered
 * decisions the model must make before acting on it. The injector only
 * *injects*; classification is the orchestrator's job.
 *
 * @param {Intent|null} active - the active intent, or null.
 * @returns {string} the contract text.
 */
function routeContract(active) {
  const lines = ['[AIDLC auto-route: ON] This user message is routed; an explicit /aidlc-* command always wins.']
  if (active !== null) {
    const s = active.state
    const g = s.gates && typeof s.gates === 'object' ? s.gates : {}
    let head = `Active intent: ${active.slug}@${s.phase ?? 'unknown'} (gate1=${g.gate1 ?? 'pending'}, gate2=${g.gate2 ?? 'pending'}`
    const us = s.unitStatus
    if (us && typeof us === 'object' && Object.keys(us).length > 0) {
      const ids = Object.keys(us)
      head += `, units ${ids.filter((id) => us[id] === 'done').length}/${ids.length} done`
    }
    lines.push(`${head}).`)
    const echo = routeEcho(s)
    if (echo !== null) lines.push(echo)
  } else {
    lines.push('Active intent: none.')
  }
  lines.push(
    'Load the aidlc skill (§3, "Auto-Route entry" and the phase protocols) BEFORE acting, then judge THIS message in order:',
    '1) Switch request (an `aidlc on/off`-class phrase) -> follow the switch contract above and skip the rest.',
    '2) Status/progress question -> answer from state.json directly; do not enter a phase and do not write files.',
    '3) Development request with no active intent -> show the one-line intent plus a 3–6 bullet split preview and ask the human to confirm (enter the lifecycle / adjust the split / answer directly without the process). Only then create the intent and run Inception (§3-A1).',
    '4) Active intent: in scope -> continue the current phase protocol; possibly out of scope -> three-way ask (extend this intent / park it in backlog / go outside the process with a written record, §3-A2). When you cannot tell, treat it as out of scope.',
    '5) gate1/gate2 approvals and the A3 plan confirmation default to the human: `gate.approval` is `advisory`, so the human answers every gate. An operator can lift it to `triage` — check the mode rather than assuming. Either way, the AUTHORITY classes (test.unlock, test.baseline, security.exception, irreversible.operation, policy.change, untrusted.authorization) are clamped in code and can never be automated.',
    "6) Everywhere else the default is `triage`: the decision model is asked FIRST, and the human only when it does not clear its band's confidence bar (trivial 0.60 / simple 0.85 / complex 0.95 — complexity raises the bar, it does not forbid automation). Applied verdicts are recorded as `AUTO-APPROVED`/`AUTO-REJECTED` and are reversible inside the veto window; a verdict below the bar ESCALATES to the human with the model's recommendation attached, and the pipeline stays blocked until they answer. Never present an applied verdict as a human one."
  )
  return lines.join('\n')
}
