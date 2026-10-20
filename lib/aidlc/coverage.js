/**
 * F4 — the mechanical AC ↔ test-point coverage check, run at the
 * `phase → gate1` transition.
 *
 * The PRD's `## 验收标准` section and the test strategy's `## 测试点清单` table
 * "映射 AC" column are compared as SETS of AC numbers:
 *
 * - coverage gaps (P − T ≠ ∅) and phantom numbers (T − P ≠ ∅) deny;
 * - a missing/unreadable artifact denies (protocol breach, not a parse limit);
 * - an artifact that is present but unparseable allows WITH a disclosure — never
 *   silently, and never fabricated into a pass.
 *
 * Carried over verbatim in behaviour from `guard-gates.mjs` (aidlc-zcode):
 * the range-cull rule, the header-NAME (not positional) column lookup, the
 * first-non-table-row table boundary, the sub/flat granularity rules, and the
 * "never guess" unparseable paths.
 *
 * Harness-free ESM (Node >= 22): no `@deepseek-ai/*` imports, no `process.env`
 * reads at module scope.
 *
 * @module dsh-aidlc/aidlc/coverage
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AC number token: `ACn` or `ACn.m`, not followed by an optional dot + letter —
 * so `AC1.x`-style placeholders never match (R2 修订：响应 m-N4).
 *
 * @returns {RegExp} a fresh global matcher.
 */
function acTokenGlobal() {
  return /AC\d+(?:\.\d+)?(?!\.?[A-Za-z])/g
}

/** Whole-token matcher: the same rule, anchored — a token enters a set only when it matches fully. */
const AC_TOKEN_FULL = /^(?:AC\d+(?:\.\d+)?(?!\.?[A-Za-z]))$/

/**
 * Range/range-like notation inside a mapped-column cell → the WHOLE cell is
 * culled (both ends produce no T evidence — 宁可少算交人工，不可多算成假覆盖).
 * R3: a plain hyphen counts too, so `AC1.1 - AC4.4` cannot smuggle two tokens in.
 */
const RANGE_CULL = /[–—~～\-－]|\.\.|…|至|到/

/** @param {string} raw - file text. @returns {string[]} lines, BOM and CR stripped. */
function linesOf(raw) {
  return String(raw)
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ''))
}

/**
 * Steps 1–3: locate the `## 验收标准` section (prefix match — the real heading is
 * `## 验收标准（可测）`; `### ` does not end it), harvest AC tokens, then
 * normalize granularity.
 *
 * Sub-numbered tokens win; a bare `ACn` is dropped as a group cover only when
 * its group has sub-numbers, otherwise the PRD is 约定混提 and unparseable.
 *
 * @param {string} prdText - `prd.md` contents.
 * @returns {{status:'ok', mode:'sub'|'flat', P:Set<string>}|{status:'unparseable', why:string}} the extraction.
 */
export function extractAcceptanceCriteria(prdText) {
  const lines = linesOf(prdText)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^## 验收标准/.test(lines[i])) {
      start = i + 1
      break
    }
  }
  if (start === -1) return { status: 'unparseable', why: 'prd.md 存在但找不到「## 验收标准」小节' }

  const body = []
  for (let i = start; i < lines.length; i++) {
    if (/^##(?!#)/.test(lines[i])) break
    body.push(lines[i])
  }

  const tokens = body.join('\n').match(acTokenGlobal()) || []
  const subs = tokens.filter((t) => t.includes('.'))
  const bares = tokens.filter((t) => !t.includes('.'))
  if (subs.length) {
    const groups = new Set(subs.map((t) => t.split('.')[0]))
    const orphans = bares.filter((b) => !groups.has(b))
    if (orphans.length) {
      return {
        status: 'unparseable',
        why: `prd 验收标准小节约定混提：子编号与无法归组的裸组编号（${orphans.join(', ')}）并存，不猜测不展开`,
      }
    }
    return { status: 'ok', mode: 'sub', P: new Set(subs) }
  }
  return { status: 'ok', mode: 'flat', P: new Set(bares) }
}

/**
 * Markdown table row → cells; `\|` is an escaped literal pipe, not a boundary.
 *
 * @param {string} line - one table row.
 * @returns {string[]} trimmed cells.
 */
export function splitTableRow(line) {
  const cells = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

/**
 * Is this a markdown separator row (`|---|---|`)?
 *
 * @param {string[]} cells - one row's cells.
 * @returns {boolean} true for the separator row.
 */
function isSeparatorRow(cells) {
  return cells.length > 1 && cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))
}

/**
 * Step 4: T evidence comes ONLY from the "映射 AC" column cells of the
 * `## 测试点清单` table.
 *
 * - the column is located by its HEADER NAME, not by position;
 * - the header row and the `|---|` separator row are skipped;
 * - the collection block is bounded: it spans only the CONSECUTIVE table-row run
 *   that follows the located header — the FIRST non-table row ends it, so rows of
 *   any later table in the same section never yield evidence (gate2-R1/M2);
 * - cells are culled whole on range notation; surviving cells are split on
 *   `[，,、/\s]+` and a token enters T iff it FULLY matches the AC regex and
 *   carries P's granularity;
 * - a missing table/header is unparseable (allow + disclose).
 *
 * @param {string} testStrategyText - `test-strategy.md` contents.
 * @param {'sub'|'flat'} mode - the PRD's granularity.
 * @returns {{status:'ok', T:Set<string>}|{status:'unparseable', why:string}} the extraction.
 */
export function extractTestPointMap(testStrategyText, mode) {
  const lines = linesOf(testStrategyText)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*测试点清单/.test(lines[i])) {
      start = i + 1
      break
    }
  }
  if (start === -1) return { status: 'unparseable', why: 'test-strategy.md 缺少「## 测试点清单」表' }

  const T = new Set()
  let col = -1
  for (let i = start; i < lines.length; i++) {
    const ln = lines[i]
    if (/^##(?!#)/.test(ln)) break
    const row = ln.trim()
    if (!row.startsWith('|')) {
      // Table-boundary rule (gate2-R1/M2): once the 映射 AC header is located,
      // the FIRST non-table row ends this table's collection block. A later
      // table in the same section has no located header of its own — rows that
      // happen to carry AC numbers at the same column index must not silently
      // patch a real coverage gap (宁可少算交人工，不可多算成假覆盖).
      if (col !== -1) break
      continue // header not yet found — prose before the table is expected
    }
    const cells = splitTableRow(row)
    if (isSeparatorRow(cells)) continue
    if (col === -1) {
      const idx = cells.indexOf('映射 AC')
      if (idx !== -1) col = idx // header row located; its own cells yield nothing
      continue
    }
    const cell = cells[col]
    if (cell === undefined || cell === '') continue
    if (RANGE_CULL.test(cell)) continue
    for (const tok of cell.split(/[，,、/\s]+/)) {
      if (!tok || !AC_TOKEN_FULL.test(tok)) continue
      if (mode === 'sub' && !tok.includes('.')) continue // group map ≠ sub evidence
      if (mode === 'flat' && tok.includes('.')) continue
      T.add(tok)
    }
  }
  if (col === -1) return { status: 'unparseable', why: 'test-strategy.md 测试点清单表找不到「映射 AC」列表头' }
  return { status: 'ok', T }
}

/**
 * The whole F4 pipeline for one `phase → gate1` transition (or its brand-new
 * intent equivalent). Short-circuits in spec order; either denies, allows with a
 * disclosure, or allows having found full coverage.
 *
 * @param {string} intentDir - `docs/aidlc/<slug>` directory.
 * @param {(path:string)=>string|null} [readFileFn] - artifact reader; returns the file text or null when
 *   missing/unreadable. Defaults to `readFileSync` (utf8). Absolute paths are requested first; a
 *   reader that works on bare names (`prd.md`) is also tolerated.
 * @returns {{kind:'allow'}|{kind:'deny', reason:string}|{kind:'allow-with-disclosure', reason:string}} the decision.
 */
export function checkCoverage(intentDir, readFileFn) {
  const dir = String(intentDir ?? '')
  /**
   * @param {string} name - artifact file name.
   * @returns {string|null} contents.
   */
  const readArt = (name) => {
    const abs = join(dir, name)
    if (typeof readFileFn === 'function') {
      try {
        const full = readFileFn(abs)
        if (typeof full === 'string') return full
        const bare = readFileFn(name)
        if (typeof bare === 'string') return bare
      } catch {
        return null
      }
      return null
    }
    try {
      return readFileSync(abs, 'utf8')
    } catch {
      return null
    }
  }

  // Step 0 — direction zero: both artifacts must exist and be readable (classic
  // and express alike). Missing at the transition is protocol breach, not a
  // parse limit; this also closes the write-state-first/restock-later ordering.
  const prdText = readArt('prd.md')
  const tsText = readArt('test-strategy.md')
  const missing = [
    ['prd.md', prdText],
    ['test-strategy.md', tsText],
  ]
    .filter(([, text]) => text === null)
    .map(([name]) => name)
  if (missing.length) {
    return {
      kind: 'deny',
      reason: `AIDLC F4 机械校验：phase→gate1 转移瞬间发现验收工件缺失或不可读取（${missing.join('、')}）——这是协议违约，不是解析局限。请先补齐 prd.md 与 test-strategy.md 再推进 gate1；若 state 与工件同时损坏，运行 /aidlc-resume 对账。`,
    }
  }

  const pRes = extractAcceptanceCriteria(prdText)
  if (pRes.status === 'unparseable') {
    return { kind: 'allow-with-disclosure', reason: `AIDLC F4 无法机械校验：${pRes.why}，交人类门与 party-review 复核。` }
  }
  if (pRes.P.size === 0) {
    return {
      kind: 'allow-with-disclosure',
      reason: 'AIDLC F4 无法机械校验：prd 验收标准小节内没有可识别的 AC 编号（P=∅），交人类门与 party-review 复核。',
    }
  }

  const tRes = extractTestPointMap(tsText, pRes.mode)
  if (tRes.status === 'unparseable') {
    return { kind: 'allow-with-disclosure', reason: `AIDLC F4 无法机械校验：${tRes.why}，交人类门与 party-review 复核。` }
  }

  // Step 5 — judgment: P−T≠∅ (gaps) and T−P≠∅ (phantoms) are both deny; when
  // both directions fire, one deny lists each side's numbers (never silent).
  const gaps = [...pRes.P].filter((x) => !tRes.T.has(x))
  const phantoms = [...tRes.T].filter((x) => !pRes.P.has(x))
  if (gaps.length || phantoms.length) {
    const parts = []
    if (gaps.length) {
      parts.push(
        `AC 覆盖缺口（P−T≠∅）：${gaps.join(', ')} 在 prd 验收标准中存在，但 test-strategy 测试点清单「映射 AC」列没有任何映射`,
      )
    }
    if (phantoms.length) {
      parts.push(`幻影编号（T−P≠∅）：${phantoms.join(', ')} 出现在 test-strategy「映射 AC」列，但 prd 验收标准中不存在`)
    }
    return { kind: 'deny', reason: `AIDLC F4 机械校验：${parts.join('；')}。请补齐测试点或修正编号后再推进 gate1。` }
  }

  // Full coverage: plain allow, no disclosure.
  return { kind: 'allow' }
}
