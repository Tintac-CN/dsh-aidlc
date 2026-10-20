/**
 * F4 — the mechanical AC ↔ test-point coverage check.
 *
 * Re-derived from the original `guard-gates.mjs` F4 section. The rules pinned
 * here: the range-cull, the header-NAME (not position) column lookup, the
 * first-non-table-row table boundary (a later table must never patch a gap),
 * sub/flat granularity, and the "never guess" unparseable path (allow WITH
 * disclosure, never a silent pass and never a fabricated deny).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { checkCoverage, extractAcceptanceCriteria, extractTestPointMap, splitTableRow } from '../lib/aidlc/coverage.js'
import { intent, prd, testStrategy, tmpRoot, write } from './helpers.mjs'

const sub = (text) => extractAcceptanceCriteria(text)

/* ─────────────────────── extractAcceptanceCriteria ─────────────────────────── */

test('PRD: the 验收标准 section is located by prefix and ended by the next ## heading', () => {
  const ok = sub('# PRD\n\n## 验收标准（可测）\n- AC1.1 a\n- AC1.2 b\n## 非目标\n- AC9.9 not an AC\n')
  assert.equal(ok.status, 'ok')
  assert.equal(ok.mode, 'sub')
  assert.deepEqual([...ok.P].sort(), ['AC1.1', 'AC1.2'])
  // a ### sub-heading does NOT end the section
  const deeper = sub('## 验收标准\n- AC1.1 a\n### 细则\n- AC1.2 b\n')
  assert.deepEqual([...deeper.P].sort(), ['AC1.1', 'AC1.2'])
  assert.equal(sub('# PRD\nno section here\n').status, 'unparseable')
})

test('PRD granularity: sub wins, a bare group cover is dropped, an ungroupable bare is 约定混提', () => {
  const withCover = sub('## 验收标准\n- AC1.1 a\n- AC1.2 b\n- AC1（组）\n')
  assert.equal(withCover.status, 'ok')
  assert.deepEqual([...withCover.P].sort(), ['AC1.1', 'AC1.2'], 'AC1 is a cover for its own group')
  const mixed = sub('## 验收标准\n- AC1.1 a\n- AC2 unrelated group\n')
  assert.equal(mixed.status, 'unparseable')
  assert.match(mixed.why, /约定混提/)
  const flat = sub('## 验收标准\n- AC1 a\n- AC2 b\n')
  assert.equal(flat.mode, 'flat')
  assert.deepEqual([...flat.P].sort(), ['AC1', 'AC2'])
})

test('PRD token grammar: AC1.x placeholders and AC-prefixed words are not criteria', () => {
  const r = sub('## 验收标准\n- AC1.1 real\n- AC2.x placeholder\n- ACTOR can do it\n')
  assert.deepEqual([...r.P], ['AC1.1'], 'AC2.x and ACTOR yield nothing')
  const flat = sub('## 验收标准\n- AC1 first\n- AC10 tenth\n- ACX not one\n')
  assert.equal(flat.mode, 'flat')
  assert.deepEqual([...flat.P].sort(), ['AC1', 'AC10'], 'AC10 is its own criterion, not AC1')
})

test('PRD: an empty section parses as ok with P=∅ (the caller discloses)', () => {
  const r = sub('## 验收标准\n- nothing numbered here\n')
  assert.equal(r.status, 'ok')
  assert.equal(r.P.size, 0)
})

test('PRD: a BOM at the start of the file does not hide the section', () => {
  const r = sub('\ufeff# PRD\n## 验收标准\n- AC1.1 a\n')
  assert.equal(r.status, 'ok')
  assert.deepEqual([...r.P], ['AC1.1'])
})

/* ───────────────────────── extractTestPointMap ─────────────────────────────── */

const table = (header, rows) => ['## 测试点清单', '', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), ''].join('\n')

test('T: the 映射 AC column is found by header NAME, not by position', () => {
  const straight = extractTestPointMap(table(['场景', '映射 AC'], [['a', 'AC1.1']]), 'sub')
  assert.equal(straight.status, 'ok')
  assert.deepEqual([...straight.T], ['AC1.1'])
  const reordered = extractTestPointMap(table(['映射 AC', '场景'], [['AC1.2', 'b']]), 'sub')
  assert.deepEqual([...reordered.T], ['AC1.2'])
  const three = extractTestPointMap(table(['场景', '测试点', '映射 AC'], [['s', 'p', 'AC1.1、AC1.2']]), 'sub')
  assert.deepEqual([...three.T].sort(), ['AC1.1', 'AC1.2'], 'cells split on 、')
})

test('T: a missing section or a missing header column is unparseable, never empty-is-fine', () => {
  assert.equal(extractTestPointMap('# nothing\n', 'sub').status, 'unparseable')
  const noHeader = extractTestPointMap('## 测试点清单\n\n| a | b |\n|---|---|\n| AC1.1 | x |\n', 'sub').status
  assert.equal(noHeader, 'unparseable')
})

test('T: range notation culls the WHOLE cell (never two tokens)', () => {
  for (const cell of ['AC1.1 - AC1.2', 'AC1.1–AC1.2', 'AC1.1~AC1.2', 'AC1.1..AC1.2', 'AC1.1 至 AC1.2', 'AC1.1到AC1.2']) {
    const r = extractTestPointMap(table(['场景', '映射 AC'], [['a', cell]]), 'sub')
    assert.equal(r.status, 'ok')
    assert.equal(r.T.size, 0, cell)
  }
})

test('T: granularity must match the PRD mode', () => {
  const dotted = table(['场景', '映射 AC'], [['a', 'AC1.1']])
  const bared = table(['场景', '映射 AC'], [['a', 'AC1']])
  assert.equal(extractTestPointMap(dotted, 'flat').T.size, 0, 'a sub token is not flat evidence')
  assert.equal(extractTestPointMap(bared, 'sub').T.size, 0, 'a group cover is not sub evidence')
  assert.deepEqual([...extractTestPointMap(bared, 'flat').T], ['AC1'])
})

test('T: the FIRST non-table row ends the collection block (gate2-R1/M2)', () => {
  const text = [
    '## 测试点清单',
    '',
    '| 场景 | 映射 AC |',
    '|---|---|',
    '| a | AC1.1 |',
    '',
    '| 场景 | 映射 AC |',
    '|---|---|',
    '| b | AC1.2 |',
    '',
  ].join('\n')
  const r = extractTestPointMap(text, 'sub')
  assert.equal(r.status, 'ok')
  assert.deepEqual([...r.T], ['AC1.1'], 'a later table must not patch a real coverage gap')
  // prose BEFORE the header is expected and does not end anything
  const withProse = ['## 测试点清单', 'some prose first', '', '| 映射 AC |', '|---|', '| AC1.1 |', ''].join('\n')
  assert.deepEqual([...extractTestPointMap(withProse, 'sub').T], ['AC1.1'])
})

test('T: cell grammar — placeholders, prose, and escaped pipes', () => {
  const r = extractTestPointMap(table(['场景', '映射 AC'], [
    ['a', 'AC1.x'],
    ['b', 'ACX1'],
    ['c', 'AC1.1.2'],
    ['d', 'AC1.1'],
    ['e', '例如 AC99 见上文'],
    ['f', ''],
  ]), 'sub')
  assert.deepEqual([...r.T], ['AC1.1'], 'only a whole-token AC number at the right granularity counts')
  assert.deepEqual(splitTableRow('| a \\| b | c |'), ['', 'a | b', 'c', ''], 'outer pipes yield empty edge cells, the escaped pipe does not split')
})

/* ───────────────────────────── checkCoverage ───────────────────────────────── */

test('checkCoverage denies a missing or unreadable artifact', (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo')
  assert.match(checkCoverage(dir).reason, /prd\.md、test-strategy\.md/)
  write(join(dir, 'prd.md'), prd())
  const onlyPrd = checkCoverage(dir)
  assert.equal(onlyPrd.kind, 'deny')
  assert.match(onlyPrd.reason, /test-strategy\.md/)
  // a reader that throws is "unreadable", not "empty"
  const throwing = checkCoverage(dir, () => {
    throw new Error('EACCES')
  })
  assert.equal(throwing.kind, 'deny')
})

test('checkCoverage: full coverage allows plainly, gaps and phantoms deny', (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo')
  write(join(dir, 'prd.md'), prd())
  write(join(dir, 'test-strategy.md'), testStrategy(['AC1.1', 'AC1.2']))
  assert.deepEqual(checkCoverage(dir), { kind: 'allow' })

  write(join(dir, 'test-strategy.md'), testStrategy(['AC1.1']))
  const gap = checkCoverage(dir)
  assert.equal(gap.kind, 'deny')
  assert.match(gap.reason, /覆盖缺口/)
  assert.match(gap.reason, /AC1\.2/)

  write(join(dir, 'test-strategy.md'), testStrategy(['AC1.1', 'AC1.2', 'AC1.3']))
  const phantom = checkCoverage(dir)
  assert.equal(phantom.kind, 'deny')
  assert.match(phantom.reason, /幻影编号/)
  assert.match(phantom.reason, /AC1\.3/)

  write(join(dir, 'test-strategy.md'), testStrategy(['AC1.1', 'AC1.3']))
  const both = checkCoverage(dir)
  assert.equal(both.kind, 'deny')
  assert.match(both.reason, /覆盖缺口/)
  assert.match(both.reason, /幻影编号/)
})

test('checkCoverage allows WITH a disclosure on every unparseable path', (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo')
  write(join(dir, 'prd.md'), '# PRD without the section\n')
  write(join(dir, 'test-strategy.md'), testStrategy(['AC1.1']))
  const noSection = checkCoverage(dir)
  assert.equal(noSection.kind, 'allow-with-disclosure')
  assert.match(noSection.reason, /无法机械校验/)

  write(join(dir, 'prd.md'), '## 验收标准\n- no numbers at all\n')
  const emptyP = checkCoverage(dir)
  assert.equal(emptyP.kind, 'allow-with-disclosure')
  assert.match(emptyP.reason, /P=∅/)

  write(join(dir, 'prd.md'), prd())
  write(join(dir, 'test-strategy.md'), '# no table here\n')
  const noTable = checkCoverage(dir)
  assert.equal(noTable.kind, 'allow-with-disclosure')
  assert.match(noTable.reason, /测试点清单/)

  write(join(dir, 'prd.md'), '## 验收标准\n- AC1.1 a\n- AC2 unrelated\n')
  write(join(dir, 'test-strategy.md'), testStrategy(['AC1.1']))
  const mixed = checkCoverage(dir)
  assert.equal(mixed.kind, 'allow-with-disclosure')
  assert.match(mixed.reason, /约定混提/)
})

test('checkCoverage accepts an injected reader: absolute first, bare name tolerated', () => {
  const files = { 'prd.md': prd(), 'test-strategy.md': testStrategy(['AC1.1', 'AC1.2']) }
  const byName = (p) => files[String(p).replace(/\\/g, '/').split('/').pop()] ?? null
  assert.deepEqual(checkCoverage('/x', byName), { kind: 'allow' }, 'a reader that only understands bare names is tolerated')
  assert.deepEqual(checkCoverage('/x', (p) => (String(p).endsWith('prd.md') ? files['prd.md'] : files['test-strategy.md'])), { kind: 'allow' })
  const empty = checkCoverage('/x', () => '')
  assert.equal(empty.kind, 'allow-with-disclosure', 'an empty artifact is present-but-unparseable, i.e. disclosed, never a silent allow and never a fabricated deny')
  assert.equal(checkCoverage('/x', () => null).kind, 'deny', 'null means missing/unreadable')
})
