/**
 * AIDLC intent state — `docs/aidlc/<slug>/state.json` — plus active-intent
 * discovery, path classification, the project-level auto-route switch, and the
 * two mechanical overwrite invariants the guards enforce.
 *
 * Harness-free ESM (Node >= 22): no `@deepseek-ai/*` imports, no `process.env`
 * reads at module scope, and every disk access happens inside a function that
 * was handed an explicit `root` / `intentDir`. Importable by `node --test` with
 * no plugin running.
 *
 * Ported from `plugins/aidlc/hooks/scripts/lib/state.mjs` (aidlc-zcode):
 * `findActiveIntent`, `loadIntent`, `slugOfPath`, `isTestFile` and
 * `readAutoConfig` keep their original semantics — including the quirks the
 * guards depend on. See docs/migration-map.md for every difference.
 *
 * @module dsh-aidlc/aidlc/state
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fromConfig } from '../i18n.js'

/** Resolve one human-facing message in the configured locale (guards.js shape). */
function msg(config, key, params = {}) {
  return fromConfig(config, key, params)
}

/**
 * One intent on disk.
 *
 * `state` is `null` only for a `state.json` that exists but could not be read,
 * could not be parsed, or held JSON `null` (see `listIntents`). The guards
 * treat that as the corrupt case and fail closed.
 *
 * @typedef {{slug:string, statePath:string, intentDir:string, state:object|null}} Intent
 */

/** Result of an overwrite-integrity check. */
/** @typedef {{ok:true}|{ok:false, code:string, message:string}} IntegrityResult */

/**
 * Keys an overwrite of `state.json` may not DROP or NULL when they already
 * exist (architecture decision #11). `tddLockOverride` is deliberately absent:
 * clearing it is the documented unlock-then-relock path.
 */
export const PRESERVE_KEYS = Object.freeze([
  'route',
  'testBaseline',
  'unitStatus',
  'tddLock',
  'tddLockPaths',
])

/** Phases that take an intent out of the active slot (original `findActiveIntent`). */
const TERMINAL_PHASES = new Set(['done', 'archived'])

/**
 * Resolve the workspace root. `process.cwd()` is read at call time, never at
 * module scope.
 *
 * @param {string|undefined|null} root - workspace root, if known.
 * @returns {string} an absolute directory.
 */
function baseRoot(root) {
  return resolve(String(root ?? '') === '' ? process.cwd() : String(root))
}

/** @returns {string} the current time as a UTC ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Read and parse one JSON file. Never throws: absent, unreadable, malformed and
 * non-object content all yield `null`.
 *
 * @param {string} file - path to read.
 * @returns {object|null} the parsed object, or null.
 */
export function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(String(file), 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Which intent does a `docs/aidlc/<slug>/...` path belong to?
 *
 * Case-insensitive on purpose: on Windows the filesystem is case-insensitive,
 * so `Docs/AIDLC/x/plan.md` is the same file as `docs/aidlc/x/plan.md` and must
 * not slip past the guards.
 *
 * Note (faithful port): a file sitting directly in `docs/aidlc/` yields its own
 * name as the "slug" (`docs/aidlc/config.json` → `config.json`). Only guard
 * branches that then require a `state.json` are affected; those correctly find
 * nothing.
 *
 * @param {string} fp - file path, absolute or relative, any separator style.
 * @returns {string|null} the slug, or null when the path is not under `docs/aidlc/`.
 */
export function slugOfPath(fp) {
  const m = String(fp).replace(/\\/g, '/').match(/docs\/aidlc\/([^/]+)(?:\/|$)/i)
  return m ? m[1] : null
}

/**
 * Is this path a test file? Verbatim port of the original pattern list (JS/TS,
 * `tests|__tests__|spec` directories, Python, Go, Rust, Ruby, JVM).
 *
 * @param {string} fp - file path.
 * @returns {boolean} true when the path looks like a test.
 */
export function isTestFile(fp) {
  const p = String(fp).replace(/\\/g, '/')
  return /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(p)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p)
    || /(^|\/)test_[^/]*\.py$/i.test(p)
    || /_test\.py$/i.test(p)
    || /_test\.(go|rs|rb)$/i.test(p)
    || /_spec\.(rb|js|ts)$/i.test(p)
    || /(Test|Tests)\.(java|kt|cs)$/i.test(p)
    || /tests?\.(java|kt|cs)$/i.test(p)
}

/**
 * Does this path name something INSIDE an intent directory
 * (`docs/aidlc/<slug>/<...>`)? Case-insensitive.
 *
 * Project-level files (`docs/aidlc/config.json`, `docs/aidlc/backlog.md`) and
 * the `docs/aidlc/` directory itself are not intent artifacts and return false.
 *
 * @param {string} fp - file path.
 * @returns {boolean} true when the path is an intent artifact path.
 */
export function isAidlcArtifactPath(fp) {
  return /docs\/aidlc\/[^/]+\/.+/i.test(String(fp).replace(/\\/g, '/'))
}

/**
 * Rank one intent directory.
 *
 * The authoritative key is the state's own `updatedAt` (audit fix P0-2: file
 * mtime diverges from the declared semantics). mtime is only the fallback when
 * `updatedAt` is missing or unparseable. Per-intent failures are skipped, not
 * fatal.
 *
 * @param {string} base - the `docs/aidlc` directory.
 * @param {string} name - intent directory name.
 * @param {boolean} skipTerminal - drop `done` / `archived` intents.
 * @returns {{slug:string,statePath:string,intentDir:string,state:object|null,key:number}|null} candidate.
 */
function rankIntent(base, name, skipTerminal) {
  const intentDir = join(base, name)
  const statePath = join(intentDir, 'state.json')
  try {
    if (!existsSync(statePath)) return null
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    if (skipTerminal && state && typeof state === 'object' && TERMINAL_PHASES.has(String(state.phase))) return null
    const declared = Date.parse(String(state?.updatedAt ?? ''))
    const key = Number.isFinite(declared) ? declared : statSync(statePath).mtimeMs
    return { slug: name, statePath, intentDir, state, key }
  } catch {
    return null // unreadable/corrupt intent: skip
  }
}

/** @param {{slug:string,statePath:string,intentDir:string,state:object|null}} ranked @returns {Intent} */
function toIntent(ranked) {
  return { slug: ranked.slug, statePath: ranked.statePath, intentDir: ranked.intentDir, state: ranked.state }
}

/** @param {string|undefined|null} root @returns {string} the `docs/aidlc` directory. */
function aidlcBase(root) {
  return join(baseRoot(root), 'docs', 'aidlc')
}

/**
 * The active intent: the newest `docs/aidlc/<slug>/state.json` whose phase is
 * not `done`/`archived`. Ties keep the earlier directory name (faithful to the
 * original's strict `>` comparison).
 *
 * @param {string} root - workspace root.
 * @returns {Intent|null} the active intent, or null.
 */
export function findActiveIntent(root) {
  const base = aidlcBase(root)
  if (!existsSync(base)) return null
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    return null
  }
  let best = null
  for (const name of names) {
    const candidate = rankIntent(base, name, true)
    if (candidate === null) continue
    if (best === null || candidate.key > best.key) best = candidate
  }
  return best === null ? null : toIntent(best)
}

/**
 * Load one intent by slug. `null` when absent, unreadable, or not parseable —
 * or when the slug contains a path separator (never resolve outside
 * `docs/aidlc/`).
 *
 * @param {string} root - workspace root.
 * @param {string} slug - intent directory name.
 * @returns {Intent|null} the intent, or null.
 */
export function loadIntent(root, slug) {
  if (!slug || /[\\/]/.test(slug)) return null
  const statePath = join(aidlcBase(root), String(slug), 'state.json')
  try {
    if (!existsSync(statePath)) return null
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    return { slug: String(slug), statePath, intentDir: dirname(statePath), state }
  } catch {
    return null
  }
}

/**
 * Every intent on disk, including `done` and `archived`, newest first.
 *
 * Entries whose `state.json` exists but cannot be read/parsed are returned with
 * `state: null` so `/aidlc-status` and `/aidlc-resume` can show the corrupt
 * intent that the guards are failing closed on. Directories without a
 * `state.json` are skipped.
 *
 * @param {string} root - workspace root.
 * @returns {Intent[]} intents, newest first (ties by slug).
 */
export function listIntents(root) {
  const base = aidlcBase(root)
  if (!existsSync(base)) return []
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    return []
  }
  const found = []
  for (const name of names) {
    const intentDir = join(base, name)
    const statePath = join(intentDir, 'state.json')
    try {
      if (!existsSync(statePath)) continue
      let state = null
      try {
        state = JSON.parse(readFileSync(statePath, 'utf8'))
      } catch {
        state = null
      }
      const declared = Date.parse(String(state?.updatedAt ?? ''))
      const key = Number.isFinite(declared) ? declared : statSync(statePath).mtimeMs
      found.push({ slug: name, statePath, intentDir, state, key })
    } catch {
      // directory unreadable: skip, never fatal
    }
  }
  found.sort((a, b) => (b.key - a.key) || a.slug.localeCompare(b.slug))
  return found.map(toIntent)
}

/**
 * The one-line status of an intent, used by `/aidlc-status` and session
 * warm-up: slug, phase, gates, TDD lock/override, unit progress and the F1
 * route echo (three-state: absent = no echo, valid = verbatim, anything else =
 * `<value>(invalid→classic)`).
 *
 * @param {Intent|null|undefined} intent - the intent to summarise.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {string|null} the summary line, or null when there is no intent.
 */
export function activeIntentSummary(intent, config) {
  if (!intent || typeof intent !== 'object') return null
  const slug = String(intent.slug ?? '?')
  const s = intent.state
  if (!s || typeof s !== 'object') {
    return msg(config, 'state.activeIntent.unreadable', { slug })
  }
  const gates = s.gates && typeof s.gates === 'object' ? s.gates : {}
  const parts = [
    `AIDLC active intent: ${slug} (phase: ${s.phase ?? 'unknown'})`,
    `gate1=${gates.gate1 ?? 'pending'}`,
    `gate2=${gates.gate2 ?? 'pending'}`,
  ]
  if (s.tddLock) parts.push('TDD-LOCK=on')
  if (s.tddLockOverride) parts.push('TDD-OVERRIDE=on')
  const us = s.unitStatus
  if (us && typeof us === 'object' && !Array.isArray(us)) {
    const ids = Object.keys(us)
    if (ids.length) {
      const done = ids.filter((k) => us[k] === 'done')
      const pending = ids.filter((k) => us[k] !== 'done')
      parts.push(`units ${done.length}/${ids.length} done${pending.length ? ` (pending: ${pending.join(', ')})` : ''}`)
    }
  }
  const echo = routeEcho(s)
  if (echo) parts.push(echo)
  return parts.join(', ')
}

/**
 * F1 route echo (decision #12) — read-only, three states, never branched on.
 * Kept byte-identical to the original's `routeEcho` so the injectors cannot
 * drift.
 *
 * @param {object|null|undefined} state - an intent state.
 * @returns {string|null} `route=...`, or null when the field is absent.
 */
export function routeEcho(state) {
  const v = state?.route
  if (v === undefined || v === null) return null
  if (v === 'express' || v === 'classic') return `route=${v}`
  return `route=${String(v)}(invalid→classic)`
}

/**
 * A fresh intent skeleton (`state.json` §2 of the SKILL).
 *
 * `route` defaults to `classic` (the fail-safe default when the human did not
 * pick `express`); pass `route: null` explicitly to omit the field for a
 * legacy-shaped state.
 *
 * @param {{slug:string, intent?:string, route?:string|null, at?:string}} init - intent header.
 * @returns {object} the new state object.
 */
export function newState({ slug, intent = '', route = 'classic', at } = {}) {
  /** @type {Record<string, unknown>} */
  const state = {
    slug: String(slug ?? ''),
    intent: String(intent ?? ''),
    phase: 'inception',
    gates: { gate1: 'pending', gate2: 'pending' },
    tddLock: false,
    tddLockPaths: [],
    tddLockOverride: null,
    testBaseline: null,
    updatedAt: at ?? nowIso(),
    history: [],
  }
  if (route !== null) state.route = route === 'express' ? 'express' : 'classic'
  return state
}

/**
 * The two overwrite invariants (Rules 4a/4b), applied to state already in hand.
 *
 * 1. history optimistic lock — a full overwrite must carry forward every
 *    `history[].at` already on disk (an unparseable/missing next state loses
 *    everything).
 * 2. preserve-keys — an overwrite may not DROP or NULL an existing
 *    `route` / `testBaseline` / `unitStatus` / `tddLock` / `tddLockPaths`.
 *    Value changes always pass.
 *
 * @param {object|null|undefined} currentState - state currently on disk.
 * @param {object|null|undefined} nextState - state about to be written.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {IntegrityResult} ok, or the failure naming exactly what was lost.
 */
export function checkOverwrite(currentState, nextState, config) {
  const cur = currentState
  if (!cur || typeof cur !== 'object') return { ok: true }

  // Rule 4a — history optimistic lock.
  const curAts = Array.isArray(cur.history) ? cur.history.map((h) => String(h?.at ?? '')) : []
  if (curAts.length) {
    const nextAts = Array.isArray(nextState?.history)
      ? new Set(nextState.history.map((h) => String(h?.at ?? '')))
      : new Set()
    const lost = curAts.filter((at) => at && !nextAts.has(at))
    if (lost.length) {
      return {
        ok: false,
        code: 'HISTORY_LOST',
        message: msg(config, 'state.overwrite.historyLost', { count: lost.length, lost: lost.join(', ') }),
      }
    }
  }

  // Rule 4b — preserve-keys. Only meaningful when the next state parses; an
  // unparseable next state is caught by the history check above (original
  // behaviour, preserved on purpose).
  if (nextState && typeof nextState === 'object') {
    const dropped = PRESERVE_KEYS.filter(
      (k) => cur[k] !== undefined && cur[k] !== null && (nextState[k] === undefined || nextState[k] === null),
    )
    if (dropped.length) {
      return {
        ok: false,
        code: 'KEY_DROPPED',
        message: msg(config, 'state.overwrite.keysDropped', { keys: dropped.join(', ') }),
      }
    }
  }

  return { ok: true }
}

/**
 * Write `state.json` for one intent.
 *
 * Invariants enforced here, mirroring the guard's Write path:
 * - an existing-but-unparseable `state.json` is only writable with
 *   `opts.allowRepair === true` (the `/aidlc-resume` repair path), and callers
 *   repairing a state that claims a gate approved must still check the ledger
 *   receipt themselves (`ledger.gateReceiptStatus`);
 * - an overwrite of a parseable state must pass `checkOverwrite`.
 *
 * The write is atomic (temp file + rename), so a crash cannot leave a
 * half-written state behind — which is the same corruption the guards then fail
 * closed on.
 *
 * @param {string} intentDir - `docs/aidlc/<slug>` directory.
 * @param {object} nextState - the complete next state.
 * @param {{allowRepair?:boolean}} [opts] - `allowRepair` opts into the repair path.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {{ok:true}|{ok:false, code:string, message:string}} the result.
 */
export function writeState(intentDir, nextState, opts = {}, config) {
  const dir = String(intentDir ?? '')
  if (dir === '') return { ok: false, code: 'NO_INTENT_DIR', message: msg(config, 'state.write.noIntentDir') }
  if (!nextState || typeof nextState !== 'object') {
    return { ok: false, code: 'BAD_STATE', message: msg(config, 'state.write.notAnObject') }
  }
  const allowRepair = opts?.allowRepair === true
  const statePath = join(dir, 'state.json')
  const exists = existsSync(statePath)
  const current = exists ? readJson(statePath) : null

  if (exists && current === null && !allowRepair) {
    return {
      ok: false,
      code: 'STATE_CORRUPT',
      message: msg(config, 'state.write.corrupt', { path: statePath }),
    }
  }
  if (current && !allowRepair) {
    const check = checkOverwrite(current, nextState, config)
    if (!check.ok) return check
  }

  const text = `${JSON.stringify(nextState, null, 2)}\n`
  const tmp = `${statePath}.tmp-${Math.random().toString(36).slice(2)}`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, statePath)
    return { ok: true }
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best effort cleanup only
    }
    return { ok: false, code: 'WRITE_FAILED', message: msg(config, 'state.write.failed', { path: statePath, error: String(error) }) }
  }
}

/**
 * The project-level auto-route switch: `docs/aidlc/config.json`. Missing,
 * malformed or wrong-typed always means OFF — the opt-in default. Guard hooks
 * never read this file: routing can be turned off, guards cannot.
 *
 * @param {string} root - workspace root.
 * @returns {{on:boolean, exists:boolean}} the switch.
 */
export function readAutoRouteConfig(root) {
  const p = join(aidlcBase(root), 'config.json')
  try {
    if (!existsSync(p)) return { on: false, exists: false }
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    return { on: cfg?.autoRouting === true, exists: true }
  } catch {
    return { on: false, exists: true }
  }
}

/**
 * Flip the project-level auto-route switch, preserving every other key in
 * `docs/aidlc/config.json` (and creating the file/directories when needed).
 *
 * @param {string} root - workspace root.
 * @param {boolean} on - the desired state.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {{ok:true}|{ok:false, message:string}} the result.
 */
export function writeAutoRouteConfig(root, on, config) {
  const dir = aidlcBase(root)
  const p = join(dir, 'config.json')
  let cfg = {}
  try {
    const cur = JSON.parse(readFileSync(p, 'utf8'))
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) cfg = cur
  } catch {
    // missing or malformed: start from a fresh object (the switch is the only key we own)
  }
  const next = { ...cfg, autoRouting: on === true, updatedAt: nowIso() }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: msg(config, 'state.autoRoute.writeFailed', { path: p, error: String(error) }) }
  }
}

/* ───────────────────────── veto window (new in the DSH port) ───────────────
 * A substituted decision (design §5) is recorded here so it can be reversed
 * inside its veto window. Purely additive: a state with no `veto` key behaves
 * exactly as before, and no guard reads this key.
 *
 * `resolveVeto({veto:'upheld'})` means the substituted decision STANDS;
 * `resolveVeto({veto:'vetoed'})` means the substitution is REVERSED (the
 * lifecycle returns to blocked). Both outcomes are recorded verbatim in
 * `resolution`/`reversed` so an auditor never has to re-interpret the word.
 * ------------------------------------------------------------------------- */

/**
 * Record a substituted decision and open its veto window.
 *
 * Pure: returns a new state object; `state` is never mutated.
 *
 * @param {object} state - the intent state.
 * @param {{decision:object, vetoUntil?:string|number|Date|null, reason?:string, by?:string, confidence?:number|null, at?:string}} veto - what was decided.
 * @returns {object|null} the new state, or null when the input is unusable.
 */
export function armVeto(state, { decision, vetoUntil = null, reason = '', by = '', confidence = null, at } = {}) {
  if (!state || typeof state !== 'object') return null
  if (!decision || typeof decision !== 'object') return null
  return {
    ...state,
    veto: {
      status: 'armed',
      decision,
      vetoUntil: normalizeInstant(vetoUntil),
      reason: String(reason ?? ''),
      by: String(by ?? ''),
      confidence: Number.isFinite(confidence) ? Number(confidence) : null,
      armedAt: at ?? nowIso(),
      resolvedAt: null,
      resolution: '',
      reversed: false,
      note: '',
    },
  }
}

/**
 * Close a veto window: uphold the substituted decision or reverse it.
 *
 * Pure: returns a new state object. Returns null when there is no armed veto or
 * the verdict is not one of the two documented values — an unresolvable veto is
 * never silently recorded.
 *
 * @param {object} state - the intent state.
 * @param {{veto:'upheld'|'vetoed', at?:string, note?:string}} resolution - the verdict.
 * @returns {object|null} the new state, or null when the input is unusable.
 */
export function resolveVeto(state, { veto, at, note = '' } = {}) {
  if (!state || typeof state !== 'object') return null
  const current = state.veto
  if (!current || typeof current !== 'object' || current.status !== 'armed') return null
  if (veto !== 'upheld' && veto !== 'vetoed') return null
  return {
    ...state,
    veto: {
      ...current,
      status: veto,
      resolution: veto === 'vetoed' ? 'substitution-vetoed' : 'substitution-upheld',
      reversed: veto === 'vetoed',
      resolvedAt: at ?? nowIso(),
      note: String(note ?? ''),
    },
  }
}

/**
 * Is the veto window still open (the substitution can still be reversed)?
 *
 * @param {object|null|undefined} state - the intent state.
 * @param {string|number|Date} [at] - the instant to test (default: now).
 * @returns {boolean} true while an armed veto has not expired.
 */
export function isVetoPending(state, at) {
  const v = state?.veto
  if (!v || typeof v !== 'object' || v.status !== 'armed') return false
  if (v.vetoUntil === null || v.vetoUntil === undefined) return true
  const until = Date.parse(String(v.vetoUntil))
  if (!Number.isFinite(until)) return true
  const now = at === undefined ? Date.now() : toMillis(at)
  return !Number.isFinite(now) || now <= until
}

/** @param {string|number|Date|undefined|null} value @returns {string|null} ISO-8601, or the value as-is. */
function normalizeInstant(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null
  return String(value)
}

/** @param {string|number|Date} value @returns {number} epoch milliseconds (NaN when unparseable). */
function toMillis(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return Date.parse(String(value))
}
