/**
 * The AIDLC ledger — `docs/aidlc/<slug>/decisions.md` — and the gate receipts
 * inside it.
 *
 * `decisions.md` is append-only and is the human-verdict record of authority:
 * a gate may only be flipped to `approved` in `state.json` while the ledger
 * carries a live `GATE-APPROVED <gate> <date>` line for it, and a
 * `GATE-REJECTED <gate> <date>` line VOIDS every approval above it (round
 * semantics — re-approval after a rejection needs a fresh receipt).
 *
 * New in the DSH port: the decision layer may also write machine receipts,
 * `AUTO-APPROVED` / `AUTO-REJECTED`, produced by `formatAutoReceipt`. They are
 * parsed and exposed in `parseReceipts().auto`.
 *
 * Whether an AUTO receipt can satisfy a GATE is a *configured* decision, not a
 * structural impossibility: `gate.approval` is armable for `triage`, and
 * `gateReceiptStatus(text, gate, {acceptAuto:true})` then accepts an
 * `AUTO-APPROVED` line when the gate has no human receipt. It defaults to false,
 * so the two-argument call behaves exactly as before, and the guards DERIVE it
 * from the operator's effective mode (`isSubstitutable('gate.approval', …)`)
 * rather than accepting a bare boolean from a caller. A human rejection is never
 * overridable, armed or not — see the fold in `gateReceiptStatus`.
 *
 * Harness-free ESM (Node >= 22): no `@deepseek-ai/*` imports, no `process.env`
 * reads at module scope. Ported from the receipt handling in
 * `plugins/aidlc/hooks/scripts/guard-gates.mjs`; see docs/migration-map.md.
 *
 * @module dsh-aidlc/aidlc/ledger
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromConfig } from '../i18n.js'

/**
 * Resolve one human-facing message in the configured locale (guards.js shape).
 *
 * This file's MACHINE grammar — the receipt patterns, `parseReceipts`,
 * `gateReceiptStatus`, `formatGateReceipt`, `formatAutoReceipt` — is deliberately
 * NOT catalogued and must never be routed through here: a translated receipt
 * would stop parsing and break the audit chain. Only these four error strings
 * are prose.
 */
function msg(config, key, params = {}) {
  return fromConfig(config, key, params)
}

/**
 * One receipt line.
 *
 * `line` is a 1-based line number inside the ledger text. Human receipts carry
 * the core fields; auto receipts add `by`, `confidence` and `reason`.
 *
 * @typedef {{
 *   gate:'gate1'|'gate2',
 *   state:'approved'|'rejected',
 *   at:string,
 *   line:number,
 *   raw:string,
 *   auto:boolean,
 *   by?:string|null,
 *   confidence?:number|null,
 *   reason?:string,
 * }} Receipt
 */

/* ── The two receipt kinds — they MUST stay separate ────────────────────────
 * A HUMAN receipt (`GATE-APPROVED` / `GATE-REJECTED`) asserts that a person
 * approved or rejected. An AUTO receipt records that the decision layer did,
 * with a backend and a confidence attached.
 *
 * What keeps the human kind trustworthy is NOT that arming a class is refused —
 * it is not: `gate.approval` may be armed for `triage`, and an operator can then
 * configure a gate whose AUTO receipt counts (their explicit, warned choice). It
 * is that **no code path in this plugin writes a human receipt**: the
 * model-facing tool refuses to emit one (lib/surface/tools.js), `formatGateReceipt`
 * exists for the orchestrator to transcribe a human's own words, and the two
 * parsers below never conflate the kinds. The receipt is a process record, not
 * cryptographic proof of authorship.
 *
 * Do NOT "simplify" the two matchers into one, and do NOT let an AUTO line be
 * read as a human one. Being able to tell, from the ledger alone, whether a
 * person or a machine closed a gate is the entire audit value of the distinction.
 * ------------------------------------------------------------------------- */

/** A human approval/rejection line: standalone, strict format (leading spaces break it — as in the original). */
const HUMAN_RE = /^GATE-(APPROVED|REJECTED)\s+(gate1|gate2)\s+(\d{4}-\d{2}-\d{2})\s*$/

/** An auto receipt line written by the decision layer via `formatAutoReceipt`. Parse-only: never a gate receipt. */
const AUTO_RE = /^AUTO-(APPROVED|REJECTED)\s+(gate1|gate2)\s+(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/

/** The archive marker (`/aidlc-archive`, SKILL §9). */
const ARCHIVED_RE = /^ARCHIVED(?:\s|$)/

/** Auto-receipt `reason=` is bounded so one receipt always stays one line. */
const MAX_REASON = 400

/** @param {string|undefined|null} text @returns {string[]} raw lines, no CR. */
function splitLines(text) {
  return String(text ?? '').replace(/^\ufeff/, '').split(/\r?\n/)
}

/** @param {string|undefined|null} gate @returns {'gate1'|'gate2'|null} normalized gate id. */
export function normalizeGate(gate) {
  const g = String(gate ?? '').trim().toLowerCase()
  return g === 'gate1' || g === 'gate2' ? g : null
}

/** @param {string|undefined|null} verdict @returns {'approved'|'rejected'|null} normalized verdict. */
function normalizeVerdict(verdict) {
  const v = String(verdict ?? '').trim().toLowerCase()
  if (v === 'approved' || v === 'approve') return 'approved'
  if (v === 'rejected' || v === 'reject') return 'rejected'
  return null
}

/**
 * Strip control characters so a receipt always occupies exactly one line.
 *
 * @param {unknown} value - raw text.
 * @param {number} [max] - maximum length.
 * @returns {string} sanitized, trimmed text.
 */
function oneLine(value, max = MAX_REASON) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * Today's date (UTC) as `YYYY-MM-DD`.
 *
 * @returns {string} the date.
 */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Normalize a date-ish value to `YYYY-MM-DD`.
 *
 * @param {string|number|Date|undefined|null} date - an ISO timestamp/date, epoch ms, Date, or undefined for today.
 * @returns {string|null} the date, or null when unusable.
 */
function normalizeDate(date) {
  if (date === undefined || date === null || date === '') return today()
  if (date instanceof Date) {
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null
  }
  if (typeof date === 'number') {
    return Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10) : null
  }
  const s = String(date).trim()
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (!m) return null
  return Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : null
}

/** @param {string} dir - intent directory. @returns {string} the ledger path. */
function ledgerPath(dir) {
  return join(String(dir ?? ''), 'decisions.md')
}

/**
 * Read the ledger. Returns `''` when the file is absent; an unreadable file also
 * yields `''` here — use `readLedgerResult` when that distinction matters (the
 * guards do: a ledger that cannot be read must fail closed, not look empty).
 *
 * @param {string} intentDir - `docs/aidlc/<slug>` directory.
 * @returns {string} the ledger text.
 */
export function readLedger(intentDir) {
  try {
    return readFileSync(ledgerPath(intentDir), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Read the ledger, distinguishing "absent" (an empty ledger, which is normal
 * before the first decision) from "present but unreadable" (an I/O failure the
 * guards must not mistake for an empty ledger).
 *
 * @param {string} intentDir - `docs/aidlc/<slug>` directory.
 * @returns {{ok:true, text:string}|{ok:false, message:string}} the result.
 */
export function readLedgerResult(intentDir) {
  const p = ledgerPath(intentDir)
  try {
    if (!existsSync(p)) return { ok: true, text: '' }
    return { ok: true, text: readFileSync(p, 'utf8') }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

/**
 * Parse an auto receipt line. Returns null when the line is not one.
 *
 * Format (fixed field order, so parsing is deterministic):
 * `AUTO-APPROVED gate1 2026-10-20 by=systemone:Kev-4b conf=0.82 reason=...`
 *
 * @param {string} line - one raw ledger line.
 * @param {number} lineNumber - 1-based line number.
 * @returns {Receipt|null} the receipt, or null.
 */
export function parseAutoReceipt(line, lineNumber = 0) {
  const m = AUTO_RE.exec(String(line))
  if (!m) return null
  const tail = m[4] ?? ''
  const byMatch = /(?:^|\s)by=(.*?)(?=\s+(?:conf|reason)=|$)/.exec(tail)
  const confMatch = /(?:^|\s)conf=([0-9]*\.?[0-9]+)(?=\s|$)/.exec(tail)
  const reasonMatch = /(?:^|\s)reason=([\s\S]*)$/.exec(tail)
  return {
    gate: /** @type {'gate1'|'gate2'} */ (m[2]),
    state: m[1] === 'APPROVED' ? 'approved' : 'rejected',
    at: m[3],
    line: lineNumber,
    raw: String(line),
    auto: true,
    by: byMatch ? byMatch[1].trim() : null,
    confidence: confMatch ? Number(confMatch[1]) : null,
    reason: reasonMatch ? reasonMatch[1].trim() : '',
  }
}

/**
 * Parse a human receipt line (`GATE-APPROVED` / `GATE-REJECTED`).
 *
 * @param {string} line - one raw ledger line.
 * @param {number} lineNumber - 1-based line number.
 * @returns {Receipt|null} the receipt, or null.
 */
export function parseHumanReceipt(line, lineNumber = 0) {
  const m = HUMAN_RE.exec(String(line))
  if (!m) return null
  return {
    gate: /** @type {'gate1'|'gate2'} */ (m[2]),
    state: m[1] === 'APPROVED' ? 'approved' : 'rejected',
    at: m[3],
    line: lineNumber,
    raw: String(line),
    auto: false,
  }
}

/**
 * Parse every receipt in the ledger.
 *
 * `gates[g]` is the LAST human receipt line for that gate (so `state:'rejected'`
 * means the last human word was a rejection and any earlier approval is void);
 * `null` when the gate has no human receipt at all. Auto receipts are collected
 * separately, in document order, and never fill `gates` — see the module header.
 *
 * @param {string} ledgerText - the ledger contents.
 * @returns {{gates:{gate1:Receipt|null, gate2:Receipt|null}, auto:Receipt[], archived:boolean}} the parsed ledger.
 */
export function parseReceipts(ledgerText) {
  /** @type {{gate1:Receipt|null, gate2:Receipt|null}} */
  const gates = { gate1: null, gate2: null }
  /** @type {Receipt[]} */
  const auto = []
  let archived = false
  const lines = splitLines(ledgerText)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const human = parseHumanReceipt(line, i + 1)
    if (human) {
      gates[human.gate] = human
      continue
    }
    const machine = parseAutoReceipt(line, i + 1)
    if (machine) {
      auto.push(machine)
      continue
    }
    if (ARCHIVED_RE.test(line)) archived = true
  }
  return { gates, auto, archived }
}

/**
 * The effective gate status.
 *
 * Fold order — step 1 is the rule that keeps the whole thing honest:
 *  1. the LAST human receipt for the gate is `GATE-REJECTED` → `rejected`, full
 *     stop. A human said no; no machine-authored receipt may override it, armed
 *     or not. This is checked FIRST, before any auto consideration, precisely so
 *     that arming can never soften it.
 *  2. else the last human receipt is `GATE-APPROVED` → `approved` — the ZCode
 *     original's round semantics, unchanged.
 *  3. else there is NO human receipt at all, `opts.acceptAuto === true`, and the
 *     latest AUTO line for the gate is an `AUTO-APPROVED` → `approved`,
 *     attributed with `auto:true` plus the writer's `by`/`confidence`, so the
 *     audit and the guard's message can say a machine closed the gate.
 *  4. otherwise → `none`.
 *
 * `acceptAuto` defaults to false, so the two-argument call is byte-identical to
 * the original, `{state, at, line}`. The attribution fields appear ONLY on the
 * armed auto-approval, so nothing that does not opt in can observe a shape
 * change. The flag is not a free boolean: the guards derive it from the
 * operator's effective mode (`isSubstitutable('gate.approval', …)`).
 *
 * An `AUTO-REJECTED` line never produces `state:'rejected'` — a machine does not
 * register a human-style rejection (which resets the phase). Inside the auto
 * channel the last line wins, so a later AUTO-REJECTED voids an earlier
 * AUTO-APPROVED (the fail-closed direction) and yields `none`.
 *
 * @param {string} ledgerText - the ledger contents.
 * @param {'gate1'|'gate2'|string} gate - the gate to inspect.
 * @param {{acceptAuto?:boolean}} [opts] - `acceptAuto` lets an `AUTO-APPROVED` line satisfy the
 *   gate when no human receipt exists (armed triage). Default false.
 * @returns {{state:'approved'|'rejected'|'none', at:string|null, line:number|null,
 *   auto?:true, by?:string|null, confidence?:number|null}} the status.
 */
export function gateReceiptStatus(ledgerText, gate, opts = {}) {
  const g = normalizeGate(gate)
  if (g === null) return { state: 'none', at: null, line: null }
  const acceptAuto = opts?.acceptAuto === true
  const lines = splitLines(ledgerText)
  let lastHumanApproved = -1
  let lastHumanRejected = -1
  let humanAt = null
  let humanLine = null
  let lastAutoApproved = -1
  let lastAutoRejected = -1
  let autoApprovedReceipt = null
  for (let i = 0; i < lines.length; i++) {
    const human = parseHumanReceipt(lines[i], i + 1)
    if (human && human.gate === g) {
      if (human.state === 'approved') lastHumanApproved = i
      else lastHumanRejected = i
      humanAt = human.at
      humanLine = i + 1
      continue
    }
    const machine = parseAutoReceipt(lines[i], i + 1)
    if (!machine || machine.gate !== g) continue
    if (machine.state === 'approved') {
      lastAutoApproved = i
      autoApprovedReceipt = machine
    } else {
      lastAutoRejected = i
    }
  }
  // 1 — a human rejection is final (original round semantics, and the reason a
  //     machine receipt can never "outvote" a person).
  if (lastHumanRejected !== -1 && lastHumanRejected > lastHumanApproved) {
    return { state: 'rejected', at: humanAt, line: humanLine }
  }
  // 2 — a human approval stands.
  if (lastHumanApproved !== -1) return { state: 'approved', at: humanAt, line: humanLine }
  // 3 — no human receipt: an armed AUTO-APPROVED closes the gate, attributed.
  if (acceptAuto && lastAutoApproved !== -1 && lastAutoApproved > lastAutoRejected && autoApprovedReceipt) {
    return {
      state: 'approved',
      at: autoApprovedReceipt.at,
      line: lastAutoApproved + 1,
      auto: true,
      by: autoApprovedReceipt.by ?? null,
      confidence: autoApprovedReceipt.confidence ?? null,
    }
  }
  // 4 — nothing, or the latest auto line is a rejection (never `rejected`).
  return { state: 'none', at: null, line: null }
}

/**
 * The canonical human approval receipt line:
 * `GATE-APPROVED gate1 2026-10-20` — standalone, exactly what the parser reads.
 *
 * @param {'gate1'|'gate2'|string} gate - the gate.
 * @param {string|number|Date} [date] - the date (default: today, UTC).
 * @returns {string|null} the receipt line, or null when the gate/date is unusable.
 */
export function formatGateReceipt(gate, date) {
  const g = normalizeGate(gate)
  if (g === null) return null
  const d = normalizeDate(date)
  if (d === null) return null
  return `GATE-APPROVED ${g} ${d}`
}

/**
 * The canonical machine receipt line written by the decision layer:
 * `AUTO-APPROVED gate1 2026-10-20 by=systemone:Kev-4b conf=0.82 reason=...`
 *
 * `reason` is last (it runs to end of line) and optional; `by`/`conf` are
 * omitted when not supplied. Control characters are folded to spaces so a
 * receipt is always exactly one line.
 *
 * @param {{gate:'gate1'|'gate2'|string, verdict:'approved'|'rejected'|string, by?:string,
 *          confidence?:number|null, reason?:string, at?:string|number|Date}} receipt - the receipt fields.
 * @returns {string|null} the receipt line, or null when the gate/verdict is unusable.
 */
export function formatAutoReceipt({ gate, verdict, by = '', confidence = null, reason = '', at } = {}) {
  const g = normalizeGate(gate)
  if (g === null) return null
  const v = normalizeVerdict(verdict)
  if (v === null) return null
  const d = normalizeDate(at)
  if (d === null) return null
  const parts = [`AUTO-${v.toUpperCase()}`, g, d]
  const byToken = oneLine(by, 120)
  if (byToken) parts.push(`by=${byToken}`)
  if (Number.isFinite(confidence)) parts.push(`conf=${Number(confidence).toFixed(2)}`)
  const reasonText = oneLine(reason)
  if (reasonText) parts.push(`reason=${reasonText}`)
  return parts.join(' ')
}

/**
 * Append to the ledger, enforcing the append-only rule mechanically.
 *
 * Default mode takes `text` as the DESIRED FULL CONTENT (the SKILL's protocol:
 * read the whole file, write "whole file + addition"), and rejects anything that
 * does not preserve the existing content verbatim as a prefix. `opts.asChunk`
 * takes `text` as just the addition and appends it for you.
 *
 * @param {string} intentDir - `docs/aidlc/<slug>` directory.
 * @param {string} text - full next content, or the chunk to append with `opts.asChunk`.
 * @param {{asChunk?:boolean}} [opts] - append `text` as a chunk.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {{ok:true, text:string}|{ok:false, message:string}} the result, with the final ledger text.
 */
export function appendLedger(intentDir, text, opts = {}, config) {
  const dir = String(intentDir ?? '')
  if (dir === '') return { ok: false, message: msg(config, 'ledger.append.noIntentDir') }
  const existing = readLedgerResult(dir)
  if (!existing.ok) {
    return {
      ok: false,
      message: msg(config, 'ledger.append.unreadable', { error: existing.message }),
    }
  }
  const incoming = String(text ?? '')
  /** @type {string} */
  let next
  if (opts?.asChunk === true) {
    const sep = existing.text !== '' && !existing.text.endsWith('\n') ? '\n' : ''
    next = `${existing.text}${sep}${incoming}${incoming.endsWith('\n') || incoming === '' ? '' : '\n'}`
  } else if (existing.text === '' || incoming.startsWith(existing.text)) {
    next = incoming
  } else {
    return {
      ok: false,
      message: msg(config, 'ledger.append.notAppendOnly'),
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(ledgerPath(dir), next, 'utf8')
    return { ok: true, text: next }
  } catch (error) {
    return { ok: false, message: msg(config, 'ledger.append.failed', { error: String(error) }) }
  }
}
