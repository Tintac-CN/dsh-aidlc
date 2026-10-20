/**
 * F3 — the impact-surface scan.
 *
 * Sprint Planning scans each unit's referrers (imports/consumers) and writes the
 * result into the plan's Units table "影响面" column:
 * `low | med | high（引用方 N） | unknown` (SKILL §3.1 / §7).
 *
 * The honesty rules from the SKILL are enforced here:
 * - `unknown` whenever the scan tool is unavailable or the reference relation
 *   cannot be resolved — never a guessed `low`;
 * - an unknown unit must be listed under the plan's「缺口与开放问题」;
 * - `high` units must explain splitting/ordering (the caller surfaces that);
 * - if the scan is unavailable for environmental reasons across the board, the
 *   whole column degrades to the pre-F3 behaviour (no column) with a note in
 *   `plan.md` — a missing impact column must never block Sprint Planning.
 *
 * The scan is a heuristic, not a resolver: it reads import-ish statements and
 * compares module specifiers (including relative resolution). Anything it cannot
 * resolve is reported as `unknown` rather than guessed.
 *
 * Harness-free ESM (Node >= 22): no `@deepseek-ai/*` imports, no `process.env`
 * reads at module scope; the default file walker runs inside the functions that
 * need it.
 *
 * @module dsh-aidlc/aidlc/impact
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative } from 'node:path'

/**
 * One unit's impact surface.
 *
 * `degraded` marks an ENVIRONMENTAL failure (scan tool unavailable / budget
 * exhausted) as opposed to a unit that simply cannot be scanned meaningfully.
 *
 * @typedef {{
 *   unit:string,
 *   level:'low'|'med'|'high'|'unknown',
 *   count:number,
 *   referrers:string[],
 *   degraded:boolean,
 *   truncated:boolean,
 *   reason:string,
 * }} ImpactScan
 */

/** Directory names never worth scanning. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
  'target', 'vendor', '.cache', '.turbo', '.svelte-kit', '.pytest_cache',
])

/** Source extensions stripped when comparing module specifiers. */
const EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|mts|cts)$/i

/** Import-ish statements: `from '...'`, `require('...')`, `import('...')`, bare `import '...'`. */
const SPECIFIER_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
]

/** Default impact thresholds (SKILL: "分级阈值为默认方案，待 PRD OQ3 裁决后回填"). */
export const DEFAULT_IMPACT_THRESHOLDS = Object.freeze({ med: 2, high: 4 })

/** @param {unknown} value @returns {string} forward-slash, './'-stripped token. */
function normToken(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Canonical form of a module path: no extension, no trailing `/index`, no
 * leading `./`.
 *
 * @param {string} value - path or specifier.
 * @returns {string} the canonical form.
 */
function canonical(value) {
  let p = normToken(value)
  p = p.replace(EXT_RE, '')
  p = p.replace(/\/index$/, '')
  return p
}

/**
 * The module specifiers a consumer could use to reference this unit's files.
 * Exported for tests and for callers that want to show their work.
 *
 * @param {string[]} files - the unit's files (repo-relative or absolute).
 * @returns {string[]} canonical specifier forms, deduped.
 */
export function deriveModuleSpecifiers(files) {
  const set = new Set()
  for (const file of Array.isArray(files) ? files : []) {
    const c = canonical(file)
    if (c) set.add(c)
    const base = posix.basename(c)
    if (base && base !== c) set.add(base) // alias/root imports
  }
  return [...set]
}

/**
 * Default repository walker: every file under `root`, repo-relative, posix
 * separators, common build/dependency directories skipped.
 *
 * @param {string} root - workspace root.
 * @param {{maxFiles?:number, skipDirs?:Set<string>}} [opts] - limits.
 * @returns {string[]} repo-relative file paths.
 */
export function listRepoFiles(root, { maxFiles = 20000, skipDirs = SKIP_DIRS } = {}) {
  const out = []
  /** @param {string} dir - absolute directory. */
  const walk = (dir) => {
    if (out.length >= maxFiles) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip, never fatal
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue
        walk(abs)
      } else if (entry.isFile()) {
        out.push(normToken(relative(root, abs)))
      }
    }
  }
  walk(String(root ?? ''))
  return out
}

/** @param {string} abs @param {number} maxBytes @returns {string|null} file text, or null when unreadable/too big. */
function defaultReadFile(abs, maxBytes) {
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > maxBytes) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** @param {string} content @returns {string[]} module specifiers found in the content. */
function extractSpecifiers(content) {
  const found = []
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(content)) !== null) {
      if (m[1]) found.push(m[1])
      if (found.length > 5000) return found
    }
  }
  return found
}

/** @param {string} unit @param {string} reason @param {boolean} degraded @returns {ImpactScan} an unknown scan. */
function unknownScan(unit, reason, degraded) {
  return { unit, level: 'unknown', count: 0, referrers: [], degraded, truncated: false, reason }
}

/**
 * Scan one unit's referrers.
 *
 * @param {{
 *   unit?:string,
 *   files?:string[],
 *   root?:string,
 *   listFiles?:(root:string)=>string[],
 *   readFile?:(abs:string)=>string|null,
 *   thresholds?:{med?:number, high?:number},
 *   maxFiles?:number,
 *   maxBytes?:number,
 * }} input - the scan inputs. `listFiles`/`readFile` default to a recursive walk and
 *   `readFileSync`; inject them to test the levels without touching disk.
 * @returns {ImpactScan} the scan result.
 */
export function scanUnitImpact({
  unit = '',
  files = [],
  root,
  listFiles,
  readFile,
  thresholds = {},
  maxFiles = 20000,
  maxBytes = 512000,
} = {}) {
  const unitFiles = (Array.isArray(files) ? files : []).map(normToken).filter((f) => f !== '')
  if (unitFiles.length === 0) return unknownScan(unit, 'unit 未声明文件，无法派生引用关系', false)
  if (root === undefined || root === null || String(root) === '') {
    return unknownScan(unit, '未提供仓库 root，扫描工具不可用', false)
  }

  const specifiers = deriveModuleSpecifiers(unitFiles)
  if (specifiers.length === 0) return unknownScan(unit, 'unit 文件路径无法派生模块引用形式', false)
  const specSet = new Set(specifiers.map((s) => canonical(s)))

  let candidates
  try {
    candidates = typeof listFiles === 'function' ? listFiles(String(root)) : listRepoFiles(String(root), { maxFiles })
  } catch (error) {
    return unknownScan(unit, `扫描工具不可用：${String(error)}`, true)
  }
  if (!Array.isArray(candidates)) return unknownScan(unit, '扫描工具未返回文件清单', true)
  const truncated = typeof listFiles !== 'function' && candidates.length >= maxFiles

  const own = new Set(unitFiles.map((f) => canonical(f)))
  const referrers = []
  let readable = 0

  for (const candidate of candidates) {
    const rel = normToken(candidate)
    if (rel === '') continue
    if (own.has(canonical(rel))) continue // the unit's own files are not consumers
    const abs = join(String(root), rel)
    let content = null
    try {
      content = typeof readFile === 'function' ? readFile(abs) : defaultReadFile(abs, maxBytes)
    } catch {
      content = null
    }
    if (typeof content !== 'string') continue
    readable++
    let matched = false
    for (const spec of extractSpecifiers(content)) {
      if (specMatches(spec, rel, specSet)) {
        matched = true
        break
      }
    }
    if (matched) referrers.push(rel)
  }

  if (truncated) {
    return {
      unit,
      level: 'unknown',
      count: referrers.length,
      referrers: referrers.sort(),
      degraded: true,
      truncated: true,
      reason: `仓库文件数达到扫描上限 ${maxFiles}，无法保证引用方完整——按 unknown 交人工，不猜测 low`,
    }
  }
  if (readable === 0) {
    return unknownScan(unit, '候选文件全部不可读取，引用关系无法解析', true)
  }

  const high = Number.isFinite(thresholds?.high) ? Number(thresholds.high) : DEFAULT_IMPACT_THRESHOLDS.high
  const med = Number.isFinite(thresholds?.med) ? Number(thresholds.med) : DEFAULT_IMPACT_THRESHOLDS.med
  const count = referrers.length
  const level = count >= high ? 'high' : count >= med ? 'med' : 'low'
  return {
    unit,
    level,
    count,
    referrers: referrers.sort(),
    degraded: false,
    truncated: false,
    reason: level === 'high' ? `引用方 ${count} 个（≥${high}）：跨层/共享面较大，须在 plan 的执行顺序中说明拆分或排序理由` : `引用方 ${count} 个`,
  }
}

/**
 * Does one import specifier reference the unit?
 *
 * Relative specifiers are resolved against the referring file's directory before
 * comparison; bare/aliased specifiers are compared by canonical equality and by
 * path suffix (`@/foo/bar` → `src/foo/bar`).
 *
 * @param {string} spec - the imported specifier.
 * @param {string} referrerRel - the referring file, repo-relative.
 * @param {Set<string>} specSet - canonical unit specifier forms.
 * @returns {boolean} true when the import references the unit.
 */
function specMatches(spec, referrerRel, specSet) {
  const raw = normToken(spec)
  if (raw === '') return false
  const forms = new Set([canonical(raw)])
  if (raw.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(normToken(referrerRel)), raw))
    forms.add(canonical(resolved))
  }
  for (const form of forms) {
    if (specSet.has(form)) return true
    for (const target of specSet) {
      if (target !== '' && form.endsWith(`/${target}`)) return true
    }
  }
  return false
}

/**
 * Scan several units with one shared configuration (the Sprint Planning call).
 *
 * @param {{units?:Array<{unit?:string, id?:string, files?:string[]}>, root?:string,
 *          listFiles?:(root:string)=>string[], readFile?:(abs:string)=>string|null,
 *          thresholds?:{med?:number, high?:number}, maxFiles?:number, maxBytes?:number}} input - the units and options.
 * @returns {ImpactScan[]} one scan per unit, in input order.
 */
export function scanUnits({ units = [], ...opts } = {}) {
  return (Array.isArray(units) ? units : []).map((u) =>
    scanUnitImpact({ ...opts, unit: String(u?.unit ?? u?.id ?? ''), files: u?.files ?? [] }),
  )
}

/**
 * The exact cell text for the plan's Units table.
 *
 * @param {ImpactScan} scan - one scan result.
 * @returns {string} `low` | `med` | `high（引用方 N）` | `unknown`.
 */
export function formatImpactCell(scan) {
  if (!scan || typeof scan !== 'object') return 'unknown'
  if (scan.level === 'high') return `high（引用方 ${Number(scan.count) || 0}）`
  if (scan.level === 'med' || scan.level === 'low') return scan.level
  return 'unknown'
}

/**
 * Parse an impact cell back into its level/count (used to validate a hand-edited
 * plan). Returns null for anything that is not one of the four documented forms.
 *
 * @param {string} cell - the cell text.
 * @returns {{level:'low'|'med'|'high'|'unknown', count:number|null}|null} the parsed cell.
 */
export function parseImpactCell(cell) {
  const s = String(cell ?? '').trim()
  if (s === 'low' || s === 'med' || s === 'unknown') return { level: s, count: null }
  const m = /^high\s*[（(]\s*引用方\s*(\d+)\s*[)）]$/.exec(s)
  if (m) return { level: 'high', count: Number(m[1]) }
  return null
}

/**
 * Roll several scans up into the plan-level disclosures.
 *
 * @param {ImpactScan[]} scans - the scan results.
 * @returns {{
 *   environmentDegraded:boolean,
 *   allUnknown:boolean,
 *   unknownUnits:string[],
 *   highUnits:string[],
 *   openQuestions:string[],
 *   planNote:string|null,
 *   usable:boolean,
 * }} the summary; `usable:false` means the Units table keeps its pre-F3 shape.
 */
export function summarizeImpact(scans = []) {
  const list = Array.isArray(scans) ? scans.filter((s) => s && typeof s === 'object') : []
  const unknownUnits = list.filter((s) => s.level === 'unknown').map((s) => s.unit)
  const highUnits = list.filter((s) => s.level === 'high').map((s) => s.unit)
  const environmentDegraded = list.length > 0 && list.every((s) => s.level === 'unknown' && s.degraded === true)
  const openQuestions = list
    .filter((s) => s.level === 'unknown')
    .map((s) => `- [ ] unit ${s.unit} 影响面 unknown（${s.reason}）——须人工确认引用方后再排期，不得猜测填 low`)
  for (const s of list) {
    if (s.level === 'high') {
      openQuestions.push(`- [ ] unit ${s.unit} 影响面 high（引用方 ${s.count}）——须在执行顺序中说明拆分或排序理由`)
    }
  }
  const planNote = environmentDegraded
    ? '影响面扫描整体不可用（环境原因）→ 降级为现状行为：Units 表不设"影响面"列，本行即降级事实，Sprint Planning 照常起步。'
    : null
  return {
    environmentDegraded,
    allUnknown: list.length > 0 && unknownUnits.length === list.length,
    unknownUnits,
    highUnits,
    openQuestions,
    planNote,
    usable: !environmentDegraded,
  }
}
