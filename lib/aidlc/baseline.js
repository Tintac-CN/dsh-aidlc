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
 * "想记记不了", and the caller must disclose "无基线对照" instead of treating it
 * as a pass. A baseline that was recorded as unavailable also never becomes a
 * green comparison.
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
 * @returns {ParsedTestOutput|Unavailable|null} the result.
 */
function parseF2(lines) {
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
      why: `尾行 ALL ${declared} 与 pass+fail（${pass}+${fail}=${pass + fail}）交叉核对不一致——按 F2 规格判为解析失败，不得虚构 0 fail`,
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
 * @returns {ParsedTestOutput|Unavailable|null} the result.
 */
function parseNodeSummary(lines) {
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
      why: `Node 测试摘要交叉核对不一致：# tests ${fields.tests} ≠ pass+fail+cancelled+skipped+todo（${known}）——判为解析失败，不得虚构 0 fail`,
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
 * @returns {ParsedTestOutput|Unavailable} the parse result.
 */
export function parseTestOutput(text) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return { unavailable: true, why: '验证命令没有输出，无法统计（不得虚构 0 fail）' }
  const lines = splitLines(raw)
  const f2 = parseF2(lines)
  if (f2) return f2
  const node = parseNodeSummary(lines)
  if (node) return node
  return {
    unavailable: true,
    why: '输出中找不到可交叉核对的统计（F2 需要 ok/FAIL 行 + 尾行 ALL <n>；Node 测试运行器需要可交叉核对的 #/ℹ tests/pass/fail 摘要）',
  }
}

/**
 * Build a `testBaseline` object without touching an intent state.
 *
 * A non-zero exit code, a timeout, a spawn error, or unparseable output all
 * yield `unavailable:true` with null counts and a preserved suite list — the
 * explicit "想记记不了", never a silent zero.
 *
 * @param {{command?:string, output?:string, recordedAt?:string, coverage?:object|null,
 *          exitCode?:number, timedOut?:boolean, error?:string, previousSuites?:string[]}} input - the run.
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
} = {}) {
  const at = recordedAt ?? nowIso()
  const cmd = String(command ?? '')
  const preserved = Array.isArray(previousSuites) ? previousSuites.filter((x) => typeof x === 'string' && x !== '') : []
  const failedRun =
    (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0)
    || timedOut === true
    || String(error ?? '') !== ''
  if (failedRun) {
    const why = timedOut === true
      ? '验证命令超时'
      : String(error ?? '') !== ''
        ? `验证命令执行失败：${String(error).slice(0, 200)}`
        : `验证命令非零退出（exit ${exitCode}）`
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
  const parsed = parseTestOutput(output)
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
 * @returns {object} the same state object, with `testBaseline` set.
 */
export function recordBaseline(state, run = {}) {
  const previousSuites = Array.isArray(state?.testBaseline?.suites) ? state.testBaseline.suites : []
  const baseline = buildBaseline({ ...run, previousSuites })
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
 * counts, and the note discloses that ("走计数口径须在 gate2 人审呈示披露行").
 *
 * The comparison scope follows the baseline's `suites` list: suites added after
 * the baseline are not compared. `opts.suites` narrows it further (the caller
 * excludes this intent's new tests in `tddLockPaths` that way). A failing entry
 * that cannot be attributed to any suite is still compared (fail-closed) and
 * disclosed.
 *
 * @param {object|null|undefined} baseline - `state.testBaseline`.
 * @param {{output?:string, suites?:string[]}} [run] - the fresh run.
 * @returns {{verdict:'pass'|'regression'|'no-baseline'|'unavailable', newFailures:string[], note:string}} the verdict.
 */
export function compareBaseline(baseline, { output = '', suites } = {}) {
  if (!baseline || typeof baseline !== 'object') {
    return {
      verdict: 'no-baseline',
      newFailures: [],
      note: '无基线对照（state.testBaseline 缺失）：退化为「验证命令通过」即满足。若本 intent 应记未记（或记录时命令失败），验证输出与交付结论必须显式标注「无基线对照」构成告警，是否放行归人类裁决。',
    }
  }
  if (baseline.unavailable === true) {
    return {
      verdict: 'unavailable',
      newFailures: [],
      note: `基线不可用（${baseline.why ?? '记录时验证命令失败或输出不可解析'}），本次无法机械回归比对——不得静默当作通过，须显式标注「无基线对照」并由人类裁决。`,
    }
  }

  const cur = parseTestOutput(output)
  if ('unavailable' in cur) {
    return {
      verdict: 'unavailable',
      newFailures: [],
      note: `本次验证输出不可解析（${cur.why}），无法与基线比对——不得静默当作通过。`,
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
      scope
        ? '基线未记录套件清单（suites），无法排除基线后新增的套件，比对范围按本次运行可识别的套件收窄'
        : '基线未记录套件清单（suites），且本次运行套件不可识别——比对覆盖全部失败项',
    )
  }

  let unattributed = 0
  let excluded = 0
  /**
   * Scope rule: an entry that names a suite outside the baseline list is a
   * suite added after the baseline and is NOT compared (SKILL: 基线后新增的
   * 套件不比对). An entry with no path information cannot be attributed at all —
   * it IS compared, and the count is disclosed (宁可多算交人工，不可漏算成假通过).
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
    basis = '用例名比对（failingTests 名单优先）'
  } else if (baseFail !== null) {
    basis = '计数口径比对（用例名不完整或两次运行输出格式不同，须在 gate2 人审呈示披露行）'
    if (cur.fail > baseFail) {
      const scoped = (curFailing ?? []).filter((t) => inScope(t))
      newFailures = scoped.length
        ? scoped
        : [`<计数口径：fail ${baseFail} → ${cur.fail}；用例名不可解析，无法定位具体用例>`]
    }
  } else {
    return {
      verdict: 'unavailable',
      newFailures: [],
      note: '基线既无用例名也无 fail 计数，无法比对（旧格式/损坏基线）——不得静默当作通过。',
    }
  }

  if (unattributed > 0) {
    notes.push(`${unattributed} 条失败用例无法归属到基线套件清单（用例名不带路径），已一并参与比对（宁可多算交人工，不可漏算成假通过）`)
  }
  if (excluded > 0) {
    notes.push(`${excluded} 条失败用例属于基线后新增的套件，按 F2 规格未参与比对`)
  }
  notes.push(basis)
  const verdict = newFailures.length ? 'regression' : 'pass'
  const head = verdict === 'regression'
    ? `发现 ${newFailures.length} 处回归（基线中通过的用例现在失败）——BLOCKER：修复，或在 decisions.md 由人类逐字豁免。`
    : '未发现回归（基线口径下没有新的失败用例）。'
  return { verdict, newFailures, note: `${head} ${notes.join('；')}` }
}
