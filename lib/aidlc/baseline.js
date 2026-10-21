/**
 * F2 — the test baseline and regression comparison.
 *
 * Construction step 0 runs the verification command declared in `plan.md` and
 * records the result in `state.testBaseline` BEFORE any test file of this intent
 * is written. Before the gate the same command is re-run and compared: a test
 * that passed in the baseline and fails now is a REGRESSION (a BLOCKER).
 *
 * The one rule that matters here: **never fabricate `0 fail`**. An output that
 * cannot be cross-checked yields `{unavailable:true}` — the baseline then says
 * "I wanted to record this and could not", and the caller must disclose "no
 * baseline to compare against" instead of treating it as a pass. A baseline that
 * was recorded as unavailable also never becomes a green comparison.
 *
 * Recognized outputs:
 * - the AIDLC native format (SKILL §3 Construction step 0): `/^ok\b/` counts
 *   pass, `/^FAIL\b/` counts fail, and the TAIL line `ALL <n>` must equal
 *   pass+fail (missing tail or a mismatch = parse failure);
 * - the Node test-runner summary (`node --test`): `tests`/`pass`/`fail` (+
 *   `cancelled`/`skipped`/`todo` when printed) with a full cross-check.
 *
 * Harness-free ESM (Node >= 22): no `@deepseek-ai/*` imports, no `process.env`
 * reads at module scope.
 *
 * @module dsh-aidlc/aidlc/baseline
 */

import { nowIso } from './state.js'
import { fromConfig } from '../i18n.js'

/** Resolve one human-facing message in the configured locale (guards.js shape). */
function msg(config, key, params = {}) {
  return fromConfig(config, key, params)
}

/**
 * Parsed test output. `format` records which grammar matched so a comparison
 * never mixes two different naming styles. `failingTests` is omitted when the
 * runner gives no case-level lines (the comparison degrades to counts).
 *
 * @typedef {{
 *   total:number, pass:number, fail:number,
 *   failingTests?:string[], suites?:string[], format:'f2'|'node-summary',
 * }} ParsedTestOutput
 */

/** @typedef {{unavailable:true, why:string}} Unavailable */

/** F2 failing-test lines have their `FAIL` prefix stripped: the rest of the line is the name. */
const F2_FAIL_LINE = /^FAIL\b/
/** F2 passing-test lines. */
const F2_PASS_LINE = /^ok\b/
/** F2 tail line: the declared total, cross-checked against pass+fail. */
const F2_TOTAL_LINE = /^ALL\s+(\d+)\s*$/
/** Node test-runner summary lines (the spec reporter uses `ℹ`, TAP uses `#`). */
const NODE_SUMMARY_LINE = /^[#ℹ]\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/
/** TAP failing line. */
const TAP_FAIL_LINE = /^not ok\s+\d+\s*-\s*(.+)$/
/** Node spec-reporter failing line. */
const SPEC_FAIL_LINE = /^\s*✖\s+(.+)$/
/** Suite markers, best-effort: TAP subtests and explicit SUITE lines. */
const SUITE_MARKERS = [/^#\s*Subtest:\s*(.+)$/, /^SUITE\s*[:=]\s*(.+)$/i, /^[#ℹ]\s*suite\s*[:=]\s*(.+)$/i]

/** @param {unknown} text @returns {string[]} lines. */
function splitLines(text) {
  return String(text ?? '').split(/\r?\n/)
}

/** @param {string} value @returns {string} normalized path-ish token. */
function normToken(value) {
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

/**
 * Best-effort suite list: only values that look like a SOURCE FILE count, so
 * TAP `# Subtest: <test name>` markers and prose cannot pollute the comparison
 * scope.
 *
 * @param {string[]} lines - output lines.
 * @returns {string[]} suite paths, in first-seen order.
 */
function detectSuites(lines) {
  const found = []
  const seen = new Set()
  for (const line of lines) {
    for (const marker of SUITE_MARKERS) {
      const m = marker.exec(line)
      if (!m) continue
      const value = normToken(m[1])
      if (!value || !looksLikeFile(value)) break
      if (seen.has(value)) break
      seen.add(value)
      found.push(value)
      break
    }
  }
  return found
}

/**
 * Does a marker value look like a file rather than a test name?
 *
 * @param {string} value - marker value.
 * @returns {boolean} true when it is usable as a suite path.
 */
function looksLikeFile(value) {
  return value.includes('/') || /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs)$/i.test(value)
}

/**
 * Parse the AIDLC native test output. Returns null when the output is simply not
 * in that format (so the caller can try another grammar); returns `unavailable`
 * when it IS in that format but fails its own cross-check.
 *
 * @param {string[]} lines - output lines.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {ParsedTestOutput|Unavailable|null} the result.
 */
function parseF2(lines, config) {
  let pass = 0
  let fail = 0
  const failingTests = []
  for (const line of lines) {
    if (F2_PASS_LINE.test(line)) {
      pass++
      continue
    }
    if (F2_FAIL_LINE.test(line)) {
      fail++
      failingTests.push(line.replace(/^FAIL\b[:\s-]*/, '').trim())
    }
  }
  if (pass + fail === 0) return null

  let tailIndex = lines.length - 1
  while (tailIndex >= 0 && lines[tailIndex].trim() === '') tailIndex--
  const tail = tailIndex >= 0 ? lines[tailIndex] : ''
  const totalMatch = F2_TOTAL_LINE.exec(tail)
  if (!totalMatch) {
    // Not the native format (a Node/TAP run has `ok` lines but no `ALL n` tail).
    return null
  }
  const declared = Number(totalMatch[1])
  if (declared !== pass + fail) {
    return {
      unavailable: true,
      why: msg(config, 'baseline.why.f2TailMismatch', { declared, pass, fail, sum: pass + fail }),
    }
  }
  return {
    total: declared,
    pass,
    fail,
    ...(failingTests.length ? { failingTests } : {}),
    suites: detectSuites(lines),
    format: 'f2',
  }
}

/**
 * Parse the Node test-runner summary (`node --test`, spec or TAP reporter).
 *
 * @param {string[]} lines - output lines.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {ParsedTestOutput|Unavailable|null} the result.
 */
function parseNodeSummary(lines, config) {
  /** @type {Record<string, number>} */
  const fields = {}
  for (const line of lines) {
    const m = NODE_SUMMARY_LINE.exec(line)
    if (m) fields[m[1]] = Number(m[2])
  }
  if (!Number.isFinite(fields.tests) || !Number.isFinite(fields.pass) || !Number.isFinite(fields.fail)) return null

  const known = fields.pass + fields.fail + (fields.cancelled ?? 0) + (fields.skipped ?? 0) + (fields.todo ?? 0)
  if (known !== fields.tests) {
    return {
      unavailable: true,
      why: msg(config, 'baseline.why.nodeSummaryMismatch', { tests: fields.tests, known }),
    }
  }

  const failingTests = []
  for (const line of lines) {
    const tap = TAP_FAIL_LINE.exec(line)
    if (tap) {
      failingTests.push(tap[1].replace(/\s+#\s*(?:TODO|SKIP).*$/i, '').trim())
      continue
    }
    const spec = SPEC_FAIL_LINE.exec(line)
    if (!spec) continue
    const name = spec[1].replace(/\s+\(\d+(?:\.\d+)?\s*ms\)\s*$/, '').trim()
    // The spec reporter prints a `✖ failing tests:` section header as well;
    // a section header is not a test name.
    if (name === '' || name.endsWith(':')) continue
    failingTests.push(name)
  }
  return {
    total: fields.tests,
    pass: fields.pass,
    fail: fields.fail,
    ...(failingTests.length ? { failingTests: [...new Set(failingTests)] } : {}),
    suites: detectSuites(lines),
    format: 'node-summary',
  }
}

/**
 * Parse a verification command's output. Never throws and never fabricates a
 * zero: anything that cannot be cross-checked is `{unavailable:true, why}`.
 *
 * @param {string} text - captured stdout+stderr (order preserved).
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {ParsedTestOutput|Unavailable} the parse result.
 */
export function parseTestOutput(text, config) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return { unavailable: true, why: msg(config, 'baseline.why.emptyOutput') }
  const lines = splitLines(raw)
  const f2 = parseF2(lines, config)
  if (f2) return f2
  const node = parseNodeSummary(lines, config)
  if (node) return node
  return {
    unavailable: true,
    why: msg(config, 'baseline.why.noCounts'),
  }
}

/**
 * Build a `testBaseline` object without touching an intent state.
 *
 * A non-zero exit code, a timeout, a spawn error, or unparseable output all
 * yield `unavailable:true` with null counts and a preserved suite list — the
 * explicit "I wanted to record this and could not", never a silent zero.
 *
 * @param {{command?:string, output?:string, recordedAt?:string, coverage?:object|null,
 *          exitCode?:number, timedOut?:boolean, error?:string, previousSuites?:string[]}} input - the run.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {object} the baseline object (SKILL §2 schema, plus `why` when unavailable).
 */
export function buildBaseline({
  command = '',
  output = '',
  recordedAt,
  coverage = null,
  exitCode,
  timedOut = false,
  error = '',
  previousSuites = [],
} = {}, config) {
  const at = recordedAt ?? nowIso()
  const cmd = String(command ?? '')
  const preserved = Array.isArray(previousSuites) ? previousSuites.filter((x) => typeof x === 'string' && x !== '') : []
  const failedRun =
    (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0)
    || timedOut === true
    || String(error ?? '') !== ''
  if (failedRun) {
    const why = timedOut === true
      ? msg(config, 'baseline.why.timedOut')
      : String(error ?? '') !== ''
        ? msg(config, 'baseline.why.runFailed', { error: String(error).slice(0, 200) })
        : msg(config, 'baseline.why.nonZeroExit', { code: exitCode })
    return {
      recordedAt: at,
      command: cmd,
      suites: preserved,
      total: null,
      pass: null,
      fail: null,
      unavailable: true,
      why,
      coverage: null,
    }
  }
  const parsed = parseTestOutput(output, config)
  if ('unavailable' in parsed) {
    return {
      recordedAt: at,
      command: cmd,
      suites: preserved,
      total: null,
      pass: null,
      fail: null,
      unavailable: true,
      why: parsed.why,
      coverage: null,
    }
  }
  return {
    recordedAt: at,
    command: cmd,
    suites: parsed.suites ?? [],
    total: parsed.total,
    pass: parsed.pass,
    fail: parsed.fail,
    ...(parsed.failingTests ? { failingTests: parsed.failingTests } : {}),
    format: parsed.format,
    unavailable: false,
    coverage: coverage ?? null,
  }
}

/**
 * Record the baseline into an intent state (Construction step 0).
 *
 * Records IN PLACE on the passed state and returns that same object, so both
 * `recordBaseline(state, run)` and `state.testBaseline` see the result. Use
 * `buildBaseline` when a pure value is wanted. A previous `testBaseline.suites`
 * list is preserved when this run could not be parsed.
 *
 * @param {object} state - the intent state (mutated).
 * @param {{command?:string, output?:string, recordedAt?:string, coverage?:object|null,
 *          exitCode?:number, timedOut?:boolean, error?:string}} run - the verification run.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {object} the same state object, with `testBaseline` set.
 */
export function recordBaseline(state, run = {}, config) {
  const previousSuites = Array.isArray(state?.testBaseline?.suites) ? state.testBaseline.suites : []
  const baseline = buildBaseline({ ...run, previousSuites }, config)
  const target = state && typeof state === 'object' ? state : {}
  target.testBaseline = baseline
  return target
}

/**
 * Compare a fresh verification run against the baseline.
 *
 * Regression = a test that passed in the baseline now fails. Case-name
 * comparison (`failingTests`) is preferred; if either side lacks case names —
 * or the two runs used different output grammars — the comparison degrades to
 * counts, and the note discloses that ("a count-basis comparison must be shown
 * as a disclosure line at the gate2 human review").
 *
 * The comparison scope follows the baseline's `suites` list: suites added after
 * the baseline are not compared. `opts.suites` narrows it further (the caller
 * excludes this intent's new tests in `tddLockPaths` that way). A failing entry
 * that cannot be attributed to any suite is still compared (fail-closed) and
 * disclosed.
 *
 * @param {object|null|undefined} baseline - `state.testBaseline`.
 * @param {{output?:string, suites?:string[]}} [run] - the fresh run.
 * @param {object} [config] - the resolved plugin config (carries `locale`).
 * @returns {{verdict:'pass'|'regression'|'no-baseline'|'unavailable', newFailures:string[], note:string}} the verdict.
 */
export function compareBaseline(baseline, { output = '', suites } = {}, config) {
  if (!baseline || typeof baseline !== 'object') {
    return {
      verdict: 'no-baseline',
      newFailures: [],
      note: msg(config, 'baseline.note.noBaseline'),
    }
  }
  if (baseline.unavailable === true) {
    return {
      verdict: 'unavailable',
      newFailures: [],
      note: msg(config, 'baseline.note.baselineUnavailable', {
        why: baseline.why ?? msg(config, 'baseline.why.recordedUnavailable'),
      }),
    }
  }

  const cur = parseTestOutput(output, config)
  if ('unavailable' in cur) {
    return {
      verdict: 'unavailable',
      newFailures: [],
      note: msg(config, 'baseline.note.currentUnparseable', { why: cur.why }),
    }
  }

  const notes = []
  const baseSuites = Array.isArray(baseline.suites) ? baseline.suites.filter((x) => typeof x === 'string' && x !== '') : []
  const curSuites = Array.isArray(suites)
    ? suites.filter((x) => typeof x === 'string' && x !== '')
    : Array.isArray(cur.suites)
      ? cur.suites
      : []
  const scope = baseSuites.length ? baseSuites : curSuites.length ? curSuites : null
  if (!baseSuites.length) {
    notes.push(
      msg(config, scope ? 'baseline.note.suitesUnknownScoped' : 'baseline.note.suitesUnknownAll'),
    )
  }

  let unattributed = 0
  let excluded = 0
  /**
   * Scope rule: an entry that names a suite outside the baseline list is a
   * suite added after the baseline and is NOT compared (SKILL: suites added
   * after the baseline are not compared). An entry with no path information
   * cannot be attributed at all — it IS compared, and the count is disclosed
   * (better to over-count for a human than to miss a real pass).
   *
   * @param {string} entry - one failing-test entry.
   * @returns {boolean} true when the entry is inside the comparison scope.
   */
  const inScope = (entry) => {
    if (scope === null) return true
    const e = normToken(entry).toLowerCase()
    const hit = scope.some((s) => {
      const n = normToken(s).toLowerCase()
      return n !== '' && (e === n || e.includes(n))
    })
    if (hit) return true
    if (!e.includes('/')) {
      unattributed++
      return true
    }
    excluded++
    return false
  }

  const baseFailing = Array.isArray(baseline.failingTests) ? baseline.failingTests : null
  const curFailing = Array.isArray(cur.failingTests) ? cur.failingTests : null
  const comparableFormats = !baseline.format || !cur.format || baseline.format === cur.format
  const baseFail = Number.isFinite(baseline.fail) ? Number(baseline.fail) : null

  /** @type {string[]} */
  let newFailures = []
  let basis = ''

  if (baseFailing && curFailing && comparableFormats) {
    const baseSet = new Set(baseFailing.map((t) => normToken(t).toLowerCase()))
    newFailures = curFailing.filter((t) => inScope(t) && !baseSet.has(normToken(t).toLowerCase()))
    basis = msg(config, 'baseline.basis.caseNames')
  } else if (baseFail !== null) {
    basis = msg(config, 'baseline.basis.counts')
    if (cur.fail > baseFail) {
      const scoped = (curFailing ?? []).filter((t) => inScope(t))
      newFailures = scoped.length
        ? scoped
        : [msg(config, 'baseline.countBasisEntry', { from: baseFail, to: cur.fail })]
    }
  } else {
    return {
      verdict: 'unavailable',
      newFailures: [],
      note: msg(config, 'baseline.note.noComparableBasis'),
    }
  }

  if (unattributed > 0) {
    notes.push(msg(config, 'baseline.note.unattributed', { count: unattributed }))
  }
  if (excluded > 0) {
    notes.push(msg(config, 'baseline.note.excluded', { count: excluded }))
  }
  notes.push(basis)
  const verdict = newFailures.length ? 'regression' : 'pass'
  const head = verdict === 'regression'
    ? msg(config, 'baseline.head.regression', { count: newFailures.length })
    : msg(config, 'baseline.head.pass')
  return { verdict, newFailures, note: `${head} ${notes.join(msg(config, 'common.clauseSeparator'))}` }
}
