/**
 * AIDLC process guards — the mechanized form of what SKILL.md §0 promises.
 *
 * Ported from `plugins/aidlc/hooks/scripts/guard-gates.mjs` +
 * `guard-paths.mjs` + `guard-tests.mjs` (aidlc-zcode). The rule set, the order
 * in which the rules fire, and every deny CONDITION are preserved; the reasons
 * keep the original's explanatory style (which rule fired, what state caused it,
 * the exact remedy command) because in this harness the reason string is the
 * model-visible text.
 *
 *   Rule 1  Construction artifacts (plan.md / units/) require gate1 approved.
 *           D12 (port deviation): they also require that the intent HAS a
 *           parseable state.json at all. A state-less intent directory never
 *           receives Construction artifacts — SKILL §3 Inception requires the
 *           orchestrator to create state.json and the skeleton BEFORE fanning
 *           out any role, so this enforces the documented protocol instead of
 *           letting a deleted state.json open a hole. Narrow on purpose: only
 *           plan.md / units/**, so intent creation still works.
 *   Rule 2  While tddLock is on, locked test files are contracts — edits denied
 *           until a human-approved override exists (/aidlc-unlock-tests).
 *           Scope: tddLockPaths (recorded at lock time) when non-empty;
 *           otherwise every test file in the repo (legacy-intent behaviour).
 *   Rule 3  Writing gates.* = "approved" into state.json requires a live
 *           approval receipt in decisions.md: a human GATE-APPROVED that is MORE
 *           RECENT than any GATE-REJECTED for the same gate (round semantics).
 *           When the operator has armed `gate.approval` for `triage`, an
 *           AUTO-APPROVED line also satisfies a gate that has NO human receipt —
 *           and the guard then ALLOWS WITH A DISCLOSURE saying a machine closed
 *           it. A human rejection is never overridable, armed or not.
 *   Rule 4  state.json full overwrites must preserve every existing history
 *           entry (append-only history = optimistic lock) AND every existing
 *           preserve-key (route / testBaseline / unitStatus / tddLock /
 *           tddLockPaths — dropped or nulled denies, value changes pass).
 *   Rule 5  decisions.md is append-only: a full overwrite is allowed only on
 *           creation or as a pure append (existing content preserved verbatim
 *           as a prefix).
 *   Rule 6  state.json / decisions.md are Write-only: an Edit's old_string can
 *           match ANYWHERE in the file, so an Edit can silently rewrite history
 *           that Rules 4/5 only inspect on full writes.
 *   Rule 7  (F4) at the phase→gate1 transition the PRD acceptance criteria and
 *           the test-strategy "映射 AC" column are mechanically compared —
 *           see coverage.js. Missing artifacts deny; gaps/phantoms deny;
 *           unparseable allows WITH disclosure. The same check runs on a
 *           brand-new intent whose first state.json write already claims
 *           phase=gate1 or gate1=approved (bypass-a closure).
 *
 * Fail-closed: a path belonging to an intent whose state.json exists but is
 * unparseable is denied — EXCEPT rewriting that state.json itself via Write
 * (the repair path, still receipt-checked), so corruption is fixable but never
 * silently disables the guards. D12 extends the same direction to the ABSENT
 * state.json: Construction artifacts are denied there too, while the files an
 * intent is legitimately created from stay writable.
 *
 * This is process enforcement, not a security boundary (Bash/shell redirects
 * still bypass it).
 *
 * Harness-free ESM (Node >= 22): no `@deepseek-ai/*` imports, no `process.env`
 * reads at module scope.
 *
 * @module dsh-aidlc/aidlc/guards
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { checkOverwrite, findActiveIntent, isTestFile, loadIntent, slugOfPath } from './state.js'
import { gateReceiptStatus, parseReceipts, readLedgerResult } from './ledger.js'
import { checkCoverage } from './coverage.js'
import { isSubstitutable, resolveMode } from '../decision/policy.js'
import { fromConfig } from '../i18n.js'

/**
 * Resolve one human-facing message in the configured locale.
 *
 * Every deny reason below goes through this, so the language is one setting and
 * the message structure — which rule fired, what state caused it, the exact
 * remedy — is identical in both locales. Only prose is translated: the literal
 * `GATE-APPROVED <gate> <date>` format, the `/aidlc-*` remedy commands and every
 * path stay byte-identical, because a guard parser and the audit chain depend on
 * them.
 *
 * @param {object|undefined|null} config - the guard config (carries `locale`).
 * @param {string} key - the catalogue key.
 * @param {Record<string, unknown>} [params] - placeholder values.
 * @returns {string} the localized message.
 */
function msg(config, key, params = {}) {
  return fromConfig(config, key, params)
}

/**
 * A guard decision. `allow-with-disclosure` is an allow that must still be
 * shown to the model (the harness prepends it as additional context) — never
 * downgraded to a silent allow, never turned into a deny.
 *
 * @typedef {{kind:'allow'}|{kind:'deny', reason:string}|{kind:'allow-with-disclosure', reason:string}} GuardDecision
 */

/** @typedef {{protectedPaths?:boolean, constructionGate?:boolean, tddLock?:boolean, overwriteIntegrity?:boolean, acCoverage?:boolean}} GuardFlags */

const ALLOW = /** @type {GuardDecision} */ ({ kind: 'allow' })

const CONSTRUCTION_RE = /docs\/aidlc\/[^/]+\/(plan\.md|units\/)/i
const STATE_JSON_RE = /docs\/aidlc\/[^/]+\/state\.json$/i
const DECISIONS_RE = /docs\/aidlc\/[^/]+\/decisions\.md$/i
const WRITE_ONLY_RE = /docs\/aidlc\/[^/]+\/(state\.json|decisions\.md)$/i
const APPROVED_HIT_RE = /"(gate1|gate2)"\s*:\s*"approved"/g

/** Paths that deliberately look like env files; legitimate templates stay writable. */
const ALLOWED_SECRET_TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/i

/** Secret-bearing path patterns (verbatim port of guard-paths.mjs). */
const PROTECTED_PATHS = [
  { re: /(^|\/)\.env($|\.)/i, why: 'environment/secret file' },
  { re: /(^|\/)\.envrc$/i, why: 'direnv file' },
  { re: /(^|\/)secrets?($|\/)/i, why: 'secrets directory' },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, why: 'private key material' },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)($|\.)/i, why: 'SSH private key' },
  { re: /(^|\/)\.netrc$/i, why: 'credential file' },
  { re: /(^|\/)\.aws(\/|$)/i, why: 'cloud credentials' },
  { re: /(^|\/)docker\/config\.json$/i, why: 'registry credentials' },
]

/** @param {string} fp - path, any separators. @returns {string} forward-slash normalized path. */
function toPosix(fp) {
  return String(fp ?? '').replace(/\\/g, '/')
}

/** @param {string|undefined|null} root @returns {string} absolute workspace root (call-time cwd fallback). */
function baseRoot(root) {
  return resolve(String(root ?? '') === '' ? process.cwd() : String(root))
}

/** @param {string|undefined|null} root @param {string|undefined|null} fp @returns {string} absolute, posix-normalized path. */
function absPath(root, fp) {
  const raw = String(fp ?? '')
  return toPosix(isAbsolute(raw) ? raw : resolve(baseRoot(root), raw))
}

/**
 * Resolve the guard flags. An absent/partial config keeps every rule ENABLED:
 * a guard that is not told to stand down keeps standing.
 *
 * @param {GuardFlags|undefined|null} config - the resolved `config.guards` sub-config.
 * @returns {Required<GuardFlags>} the effective flags.
 */
function guardFlags(config) {
  const c =
    config && typeof config === 'object'
      ? config.guards && typeof config.guards === 'object'
        ? config.guards
        : config
      : null
  return {
    protectedPaths: c?.protectedPaths !== false,
    constructionGate: c?.constructionGate !== false,
    tddLock: c?.tddLock !== false,
    overwriteIntegrity: c?.overwriteIntegrity !== false,
    acCoverage: c?.acCoverage !== false,
  }
}

/** @param {string} reason @returns {GuardDecision} a deny decision. */
function deny(reason) {
  return { kind: 'deny', reason }
}

/** @param {unknown} text @returns {object|null} parsed object, or null when not JSON/not an object. */
function parseJsonOrNull(text) {
  try {
    const value = JSON.parse(String(text))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * The slug an AIDLC-artifact path belongs to. Thin alias of `state.slugOfPath`
 * kept for callers that reach for a guard-shaped name.
 *
 * @param {string} filePath - file path.
 * @returns {string|null} the slug, or null.
 */
export function slugForGuard(filePath) {
  return slugOfPath(String(filePath ?? ''))
}

/**
 * Rule: hard-deny writes to secret-bearing paths. Structured file_path matching
 * only (Bash text matching is bypassable and over-blocks reads). This is a
 * process guardrail, not a security boundary.
 *
 * @param {{filePath:string, config?:object}} input - the candidate path, and the guard config for its locale.
 * @returns {GuardDecision} allow, or deny naming the pattern class.
 */
export function guardPaths({ filePath, config } = /** @type {{filePath:string, config?:object}} */ ({})) {
  const fp = toPosix(filePath)
  if (ALLOWED_SECRET_TEMPLATE.test(fp)) return ALLOW
  for (const pattern of PROTECTED_PATHS) {
    if (pattern.re.test(fp)) {
      return deny(
        msg(config, 'guard.paths.protected', { path: fp, why: pattern.why }),
      )
    }
  }
  return ALLOW
}

/**
 * The decision sub-config, when the caller supplied one.
 *
 * The guard receives `config.guards` for its own flags; the operator's
 * gate-receipt choice lives in `config.decision`. Callers pass it as
 * `config.decision` — either on the guard sub-config
 * (`{...config.guards, decision: config.decision}`) or by passing the whole
 * resolved config. When it is absent the auto path stays OFF, which is the
 * fail-closed direction for a guard that cannot see the configuration.
 *
 * @param {object|undefined|null} config - the guard config, optionally carrying `decision`.
 * @returns {object|null} the decision sub-config, or null.
 */
function decisionConfigOf(config) {
  const nested = config && typeof config === 'object' ? config.decision : null
  return nested && typeof nested === 'object' ? nested : null
}

/**
 * The gate-receipt policy, DERIVED from the operator's effective mode.
 *
 * `acceptAuto` is true only when `gate.approval` resolves to `triage` under the
 * decision config — the same predicate the arbiter asks
 * (`isSubstitutable`, which is exactly `resolveMode(...) === 'triage'`). It is
 * computed here rather than accepted as a boolean on purpose: a bare `true` from
 * a caller would be a forge switch, and the whole point is that the receipt
 * follows the operator's configuration instead.
 *
 * @param {object|undefined|null} config - the guard config, optionally carrying `decision`.
 * @returns {{acceptAuto:boolean, mode:string|null}} the policy; `mode` feeds the deny text.
 */
function gateReceiptPolicy(config) {
  const decisionConfig = decisionConfigOf(config)
  if (decisionConfig === null) return { acceptAuto: false, mode: null }
  return {
    acceptAuto: isSubstitutable('gate.approval', decisionConfig),
    mode: resolveMode({ decisionClass: 'gate.approval', config: decisionConfig }),
  }
}

/**
 * Join two disclosure strings (the harness carries one per call).
 *
 * @param {string|null} a - accumulated disclosure.
 * @param {string|null|undefined} b - new disclosure.
 * @returns {string|null} the merged disclosure.
 */
function mergeDisclosure(a, b) {
  if (!a) return b ?? null
  if (!b) return a
  return `${a} ${b}`
}

/**
 * Why a gate write was denied, and — when the ledger shows them — what the AUTO
 * receipts were doing.
 *
 * The second half exists because an operator who armed `gate.approval` and still
 * sees a denial deserves to be told which of the three causes it was: no receipt
 * at all, a human rejection (never overridable), or an AUTO line that does not
 * count because the class is not armed for `triage`.
 *
 * @param {string} gate - the gate being set to approved.
 * @param {{state:string, at:string|null, auto?:true}} status - the receipt status.
 * @param {string} ledgerText - the ledger contents.
 * @param {{acceptAuto:boolean, mode:string|null}} policy - the derived policy.
 * @param {object|undefined|null} config - the guard config, for the locale.
 * @returns {string} the deny reason.
 */
function receiptDenyReason(gate, status, ledgerText, policy, config) {
  const base = msg(config, 'guard.receipt.missing', { gate })
  const autoForGate = parseReceipts(ledgerText).auto.filter((r) => r.gate === gate)
  if (status.state === 'rejected') {
    const when = status.at ? ` (${status.at})` : ''
    return `${base}${msg(config, 'guard.receipt.rejected', {
      when,
      hadAuto: autoForGate.length ? msg(config, 'guard.receipt.rejectedHadAuto') : '',
    })}`
  }
  if (autoForGate.length) {
    const list = autoForGate
      .map((r) => `${r.state === 'approved' ? 'AUTO-APPROVED' : 'AUTO-REJECTED'} ${r.at}`)
      .join(msg(config, 'common.listSeparator'))
    // The mode id itself is machine text and is never translated; only the
    // sentence around it is.
    const modeText =
      policy.mode === null
        ? msg(config, 'guard.receipt.modeUnset')
        : msg(config, 'guard.receipt.modeIs', { mode: policy.mode })
    return `${base}${msg(config, 'guard.receipt.autoPresent', { count: autoForGate.length, list, modeText })}`
  }
  return base
}

/**
 * Rule 3 core, shared by the normal path, the brand-new-intent path and the
 * corrupt-state repair path: every gate being set to "approved" needs a live
 * receipt.
 *
 * Round semantics for humans: a GATE-REJECTED line for the same gate voids every
 * APPROVED receipt above it — re-approval after a rejection needs a fresh
 * receipt.
 *
 * Armed triage: when `policy.acceptAuto` is true, an `AUTO-APPROVED` line closes
 * a gate that has no human receipt. That is a machine act, so it is reported as a
 * DISCLOSURE (never silently) and the caller surfaces "a machine closed this
 * gate". A human rejection is never overridable: `gateReceiptStatus` checks it
 * first, before any auto consideration.
 *
 * @param {string} text - the proposed `state.json` content.
 * @param {string} intentDir - the intent directory holding `decisions.md`.
 * @param {{acceptAuto:boolean, mode:string|null}} policy - the derived gate-receipt policy.
 * @param {object|undefined|null} [config] - the guard config, for the locale.
 * @returns {{deny:GuardDecision|null, disclosure:string|null}} a deny, a disclosure, or neither.
 */
function checkGateReceipts(text, intentDir, policy, config) {
  const hits = String(text).match(APPROVED_HIT_RE) || []
  if (hits.length === 0) return { deny: null, disclosure: null }
  const ledger = readLedgerResult(intentDir)
  let disclosure = null
  for (const hit of hits) {
    const g = /gate1|gate2/.exec(hit)?.[0] ?? 'gate1'
    if (!ledger.ok) {
      return {
        deny: deny(msg(config, 'guard.receipt.ledgerUnreadable', { error: ledger.message, gate: g })),
        disclosure: null,
      }
    }
    const status = gateReceiptStatus(ledger.text, g, { acceptAuto: policy.acceptAuto })
    if (status.state !== 'approved') {
      return { deny: deny(receiptDenyReason(g, status, ledger.text, policy, config)), disclosure: null }
    }
    if (status.auto === true) {
      const by = status.by ? ` by=${status.by}` : ''
      const conf = Number.isFinite(status.confidence) ? ` conf=${status.confidence}` : ''
      disclosure = mergeDisclosure(
        disclosure,
        msg(config, 'guard.receipt.machineClosed', { gate: g, at: status.at ?? '?', by, conf }),
      )
    }
  }
  return { deny: null, disclosure }
}

/**
 * The pre-write guard: Rules 1–7 in the original's firing order.
 *
 * Firing order (a deny returns immediately, so the first applicable rule wins):
 * protected paths → corrupt/new-intent state → Construction gate → TDD lock →
 * Write-only → gate receipts → optimistic lock/preserve-keys → F4 coverage →
 * decisions.md append-only.
 *
 * @param {{
 *   filePath:string,
 *   isEdit?:boolean,
 *   content?:string|undefined,
 *   root?:string,
 *   config?:GuardFlags,
 * }} input - the candidate write.
 *   `content` is the whole-file content (the harness `write` tool's `content`
 *   arg) and is `undefined` for an Edit or for a write whose full content the
 *   guard cannot see.
 * @returns {GuardDecision} the decision.
 */
export function guardWrite({ filePath, isEdit = false, content, root, config } = /** @type {any} */ ({})) {
  const flags = guardFlags(config)
  const isEditTool = isEdit === true
  const wholeFile = !isEditTool && typeof content === 'string'
  const text = typeof content === 'string' ? content : ''
  const abs = absPath(root, filePath)
  // The operator's effective gate-receipt policy, DERIVED from the decision
  // config — never a bare boolean a caller could flip (see gateReceiptPolicy).
  const receiptPolicy = gateReceiptPolicy(config)
  /** @type {string|null} */
  let disclosure = null

  // guard-paths ran as its own PreToolUse hook BEFORE guard-gates: keep that
  // order so a secret path is denied with the secret-path reason.
  if (flags.protectedPaths) {
    const pathDecision = guardPaths({ filePath: abs, config })
    if (pathDecision.kind === 'deny') return pathDecision
  }

  const slug = slugOfPath(abs)
  const own = slug ? loadIntent(root, slug) : null

  if (slug && !own) {
    const intentDir = join(baseRoot(root), 'docs', 'aidlc', slug)
    const statePath = join(intentDir, 'state.json')
    if (!existsSync(statePath)) {
      // D12 — Rule 1 for a STATELESS intent (deliberate deviation; see header).
      // The original allowed every non-state.json path here, so a fresh (or
      // state.json-deleted) intent directory could receive plan.md / units/**
      // before Gate#1. That permissiveness was an oversight: SKILL §3 Inception
      // requires state.json and the skeleton to exist BEFORE roles are fanned
      // out, so requiring a parseable state before a Construction artifact
      // enforces the documented protocol. Deliberately narrow — the files an
      // intent is created FROM (intent.md, prd.md, test-strategy.md,
      // decisions.md, reviews/**, and the fresh state.json itself) all stay
      // writable, so intent creation cannot deadlock here.
      if (flags.constructionGate && CONSTRUCTION_RE.test(abs)) {
        return deny(
          msg(config, 'guard.state.stateless', { slug, path: abs }),
        )
      }
      // Brand-new intent (no state.json on disk). Bypass-a closure: a FIRST
      // write that already claims phase=gate1 or gate1=approved runs the same
      // receipt check + full F4 as the normal path, so deleting state.json
      // cannot dodge F4. Artifacts usually don't exist yet → deny; present but
      // unparseable → allow+disclose. Plain creation (below gate1) stays silent.
      if (wholeFile && STATE_JSON_RE.test(abs)) {
        const next = parseJsonOrNull(text)
        if (next && (next.phase === 'gate1' || next?.gates?.gate1 === 'approved')) {
          const receipt = checkGateReceipts(text, intentDir, receiptPolicy, config)
          if (receipt.deny) return receipt.deny
          disclosure = mergeDisclosure(disclosure, receipt.disclosure)
          if (flags.acCoverage) {
            // `config` is threaded through so the coverage prose follows the
            // configured `locale`. Without it the F4 disclosure rendered English
            // under `locale: zh-CN` while every guard message beside it rendered
            // Chinese — a half-translated denial, which is worse than either
            // language used consistently.
            const coverage = checkCoverage(intentDir, undefined, config)
            if (coverage.kind === 'deny') return coverage
            if (coverage.kind === 'allow-with-disclosure') disclosure = mergeDisclosure(disclosure, coverage.reason)
          }
        }
      }
      return disclosure === null ? ALLOW : { kind: 'allow-with-disclosure', reason: disclosure }
    }
    // state.json on disk but unparseable = corrupt. Fail closed for every path
    // except repairing that state.json itself via Write (receipt-checked above).
    if (STATE_JSON_RE.test(abs) && !isEditTool) {
      const receipt = checkGateReceipts(text, intentDir, receiptPolicy, config)
      if (receipt.deny) return receipt.deny
      disclosure = mergeDisclosure(disclosure, receipt.disclosure)
      return disclosure === null ? ALLOW : { kind: 'allow-with-disclosure', reason: disclosure }
    }
    return deny(
      msg(config, 'guard.state.corrupt', { slug, path: abs }),
    )
  }

  const intent = own || findActiveIntent(root)
  if (!intent) return ALLOW

  const s = intent.state && typeof intent.state === 'object' ? intent.state : {}
  const gates = s.gates && typeof s.gates === 'object' ? s.gates : {}
  const dir = intent.intentDir ?? dirname(intent.statePath)

  // Rule 1 — no Construction artifacts before Gate#1 approval.
  if (flags.constructionGate && CONSTRUCTION_RE.test(abs) && gates.gate1 !== 'approved') {
    return deny(
      msg(config, 'guard.construction.notApproved', { state: gates.gate1 ?? 'pending', path: abs }),
    )
  }

  // Rule 2 — TDD lock: locked test files are contracts; human unlock required.
  if (flags.tddLock && s.tddLock && isTestFile(abs) && !s.tddLockOverride) {
    const scope = Array.isArray(s.tddLockPaths) ? s.tddLockPaths : null
    let inScope = true // no/empty list = whole repo (legacy intents, documented)
    if (scope && scope.length) {
      const norm = (x) => toPosix(x).toLowerCase()
      const fpl = norm(abs)
      inScope = scope.some((p) => {
        const pl = norm(p)
        return fpl === pl || fpl.endsWith(`/${pl}`)
      })
    }
    if (inScope) {
      return deny(
        msg(config, 'guard.tddLock.denied', { slug: intent.slug, path: abs }),
      )
    }
  }

  // Rule 6 — state.json / decisions.md are Write-only (see header).
  if (isEditTool && WRITE_ONLY_RE.test(abs)) {
    const what = DECISIONS_RE.test(abs) ? 'decisions.md' : 'state.json'
    return deny(
      msg(config, 'guard.writeOnly.edit', { what }),
    )
  }

  // Rule 6b — the same rule for a write whose whole-file content the guard
  // cannot see: without the content there is no way to check the prefix
  // (decisions.md) or the optimistic lock (state.json), so an EXISTING file is
  // not writable this way. A file that does not exist yet loses nothing.
  if (!isEditTool && content === undefined && WRITE_ONLY_RE.test(abs) && existsSync(abs)) {
    const what = DECISIONS_RE.test(abs) ? 'decisions.md' : 'state.json'
    const checked = what === 'decisions.md'
      ? msg(config, 'guard.writeOnly.checkedDecisions')
      : msg(config, 'guard.writeOnly.checkedState')
    return deny(
      msg(config, 'guard.writeOnly.noContent', { what, checked }),
    )
  }

  if (STATE_JSON_RE.test(abs) && wholeFile) {
    // Rule 3 — human receipt required before state.json says approved.
    const receipt = checkGateReceipts(text, dir, receiptPolicy, config)
    if (receipt.deny) return receipt.deny
    disclosure = mergeDisclosure(disclosure, receipt.disclosure)

    const next = parseJsonOrNull(text)
    if (existsSync(intent.statePath)) {
      let cur = null
      try {
        cur = JSON.parse(readFileSync(intent.statePath, 'utf8'))
      } catch {
        cur = null
      }
      if (cur && typeof cur === 'object') {
        // Rule 4 — optimistic lock + preserveKeys against the state on disk.
        if (flags.overwriteIntegrity) {
          // Same reason as the F4 call above: the overwrite refusal is user-facing
          // prose and must follow `locale` like the rest of the guard messages.
          const check = checkOverwrite(cur, next, config)
          if (!check.ok) return deny(check.message)
        }
        // Rule 7 — F4 fires only at the phase→gate1 transition (an overwrite
        // while already at gate1, or any other phase move, never re-triggers).
        if (flags.acCoverage && next && next.phase === 'gate1' && cur.phase !== 'gate1') {
          const coverage = checkCoverage(dir, undefined, config)
          if (coverage.kind === 'deny') return coverage
          if (coverage.kind === 'allow-with-disclosure') disclosure = mergeDisclosure(disclosure, coverage.reason)
        }
      }
    }
  }

  // Rule 5 — decisions.md is append-only: a Write overwrite must be a creation
  // or a pure append (Edit is already denied by Rule 6).
  if (DECISIONS_RE.test(abs) && !isEditTool && typeof content === 'string') {
    const ledger = readLedgerResult(dir)
    if (!ledger.ok) {
      return deny(
        msg(config, 'guard.ledger.unreadable', { error: ledger.message }),
      )
    }
    if (ledger.text !== '' && !text.startsWith(ledger.text)) {
      return deny(
        msg(config, 'guard.ledger.notAppendOnly'),
      )
    }
  }

  return disclosure === null ? ALLOW : { kind: 'allow-with-disclosure', reason: disclosure }
}

/**
 * The post-write guard: react when a test file is edited while the TDD lock is
 * on. Tests are contracts — the right move is to stop and report, not to
 * reshape the contract. This is a warning (additional context), not a deny.
 *
 * Two distinct messages: a raw lock hit is a violation warning; an override hit
 * is a legitimate unlock window — remind to re-lock, don't cry wolf.
 *
 * @param {{filePath:string, root?:string, config?:GuardFlags}} input - the write that just happened.
 * @returns {{kind:'warn', message:string}|{kind:'allow'}} the decision.
 */
export function guardTestsPostWrite({ filePath, root, config } = /** @type {any} */ ({})) {
  const flags = guardFlags(config)
  if (!flags.tddLock) return ALLOW
  const fp = String(filePath ?? '')
  const active = findActiveIntent(root)
  if (!active || !active.state || typeof active.state !== 'object') return ALLOW
  if (!active.state.tddLock || !isTestFile(fp)) return ALLOW
  const override = active.state.tddLockOverride
  const message = override
    ? msg(config, 'guard.tddLock.postWriteOverride', {
      at: override.at ?? '?',
      reason: String(override.reason ?? '?').slice(0, 200),
      path: fp,
    })
    : msg(config, 'guard.tddLock.postWriteWarning', { path: fp, slug: active.slug })
  return { kind: 'warn', message }
}
