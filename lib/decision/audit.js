/**
 * The decision audit trail: one JSONL line per decision, append-only.
 *
 * Two rules shape this module:
 *  1. **Nothing here may throw into the decision path.** A lost audit line must
 *     not turn into a lost decision; the arbiter is told when a write fails and
 *     refuses to substitute in that case (see `arbiter.js`), which is the one
 *     safe response to "the audit is broken".
 *  2. **Nothing here may leak.** Entries are scrubbed of secret-shaped keys and
 *     over-long strings before they are serialized, so an operator can commit
 *     the audit file to the repository.
 *
 * @module dsh-aidlc/decision/audit
 */
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/** Where decision audit lines are written, relative to the session workspace. */
export const DEFAULT_AUDIT_PATH = 'docs/aidlc/decision-audit.jsonl'

/** Keys whose values are never written to disk, whatever the caller passes. */
const SECRET_KEY = /(api[-_]?key|authorization|bearer|token|secret|password|passwd|credential|cookie|session[-_]?id)/i

/** Longest string value kept verbatim; the rest is truncated with a marker. */
const MAX_STRING = 2000

/** Deepest structure copied; deeper values become a placeholder. */
const MAX_DEPTH = 6

/**
 * Copy an audit entry into something safe to serialize: secret-shaped keys
 * dropped, long strings truncated, cycles cut off.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeEntry(value, depth = 0) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string') {
    const text = /** @type {string} */ (value)
    return text.length > MAX_STRING ? text.slice(0, MAX_STRING) + `…[+${text.length - MAX_STRING}]` : text
  }
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'boolean') return value
  if (type === 'bigint') return String(value)
  if (type === 'function' || type === 'symbol') return undefined
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeEntry(item, depth + 1))
  if (type === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (SECRET_KEY.test(key)) continue
      const copy = sanitizeEntry(item, depth + 1)
      if (copy !== undefined) out[key] = copy
    }
    return out
  }
  return undefined
}

/**
 * One audit line. Never throws: an unserializable entry degrades to a minimal
 * line that still records that a decision happened.
 *
 * @param {object} entry
 * @returns {string} a single JSONL line, newline-terminated.
 */
export function formatAuditLine(entry) {
  const base = entry && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {}
  try {
    const clean = sanitizeEntry(base)
    const line = JSON.stringify(clean && typeof clean === 'object' ? clean : { note: 'unserializable audit entry' })
    return line + '\n'
  } catch {
    try {
      return JSON.stringify({
        ts: new Date().toISOString(),
        source: typeof base.source === 'string' ? base.source : 'unknown',
        substituted: base.substituted === true,
        note: 'audit entry could not be serialized in full',
      }) + '\n'
    } catch {
      return '{"note":"audit entry could not be serialized"}\n'
    }
  }
}

/**
 * Read back JSONL audit text.
 *
 * @param {string} text
 * @returns {{entries: object[], malformed: number, total: number}}
 */
export function parseAuditLines(text) {
  const lines = String(text ?? '').split('\n')
  /** @type {object[]} */
  const entries = []
  let malformed = 0
  let total = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    total++
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { entries, malformed, total }
}

/**
 * Resolve the audit file path against a workspace root.
 *
 * @param {string} [file] configured path (relative paths resolve from `root`).
 * @param {string} [root] workspace root; defaults to the process cwd.
 * @returns {string|null} an absolute path, or null when nothing is configured.
 */
export function resolveAuditPath(file = DEFAULT_AUDIT_PATH, root = '') {
  const wanted = String(file ?? '').trim()
  if (!wanted) return null
  const base = String(root ?? '').trim() || (typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '')
  return path.isAbsolute(wanted) ? wanted : path.resolve(base, wanted)
}

/**
 * Create the audit sink.
 *
 * `record(entry)` returns immediately (the arbiter's `deps.record` contract is
 * synchronous) and queues the append behind an internal promise chain, so lines
 * keep their order. Call `flush()` to await durability — the operator command
 * and the tests do.
 *
 * @param {object} [options]
 * @param {string} [options.path] JSONL path (relative paths resolve from `root`).
 * @param {string} [options.root] workspace root.
 * @param {boolean} [options.enabled] when false, records are buffered but not written.
 * @param {{appendFile?:Function, mkdir?:Function}} [options.fs] injected fs (tests never touch disk).
 * @param {() => number} [options.now] clock.
 * @param {(error:unknown) => void} [options.onError] observer for write failures.
 * @param {number} [options.maxBuffered] in-memory ring size for `entries()`.
 * @returns {{record:(entry:object)=>{ok:boolean, code?:string}, flush:()=>Promise<void>, entries:()=>object[], file:string|null, enabled:boolean, lastError:()=>string|null}}
 */
export function createAuditSink({
  path: file = DEFAULT_AUDIT_PATH,
  root = '',
  enabled = true,
  fs,
  now = () => Date.now(),
  onError,
  maxBuffered = 500,
} = {}) {
  const resolved = resolveAuditPath(file, root)
  const write = typeof fs?.appendFile === 'function' ? fs.appendFile : appendFile
  const ensureDir = typeof fs?.mkdir === 'function' ? fs.mkdir : mkdir
  /** @type {object[]} */
  const buffered = []
  let lastError = null
  let chain = Promise.resolve()

  const record = (entry) => {
    if (!resolved) return { ok: false, code: 'no-path' }
    const base = entry && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {}
    const line = formatAuditLine(base)
    try {
      const clean = sanitizeEntry(base)
      if (clean && typeof clean === 'object') {
        buffered.push(/** @type {object} */ (clean))
        if (buffered.length > maxBuffered) buffered.shift()
      }
    } catch {
      /* the buffer is a convenience; the file is the record */
    }
    if (!enabled) return { ok: true, code: 'disabled' }
    chain = chain.then(async () => {
      try {
        await ensureDir(path.dirname(resolved), { recursive: true })
        await write(resolved, line, 'utf8')
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        try {
          onError?.(error)
        } catch {
          /* an observer must never break the sink */
        }
      }
    })
    return { ok: true }
  }

  return {
    record,
    flush: () => chain,
    entries: () => buffered.slice(),
    file: resolved,
    enabled,
    lastError: () => lastError,
    now,
  }
}

/**
 * Read the audit file back through an injected reader (no fs import needed by
 * the caller beyond what it already has).
 *
 * @param {string|null} file
 * @param {(path:string)=>Promise<string>} readFileFn
 * @returns {Promise<{entries:object[], malformed:number, total:number}>}
 */
export async function readAuditFile(file, readFileFn) {
  if (!file || typeof readFileFn !== 'function') return { entries: [], malformed: 0, total: 0 }
  try {
    return parseAuditLines(await readFileFn(file))
  } catch {
    return { entries: [], malformed: 0, total: 0 }
  }
}
