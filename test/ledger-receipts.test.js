/**
 * The gate-receipt chain — the single most safety-critical contract in the port.
 *
 * Re-derived from the ORIGINAL `hooks/scripts/guard-gates.mjs`:
 *   - a gate may only be `approved` in `state.json` while `decisions.md` carries a
 *     standalone `^GATE-APPROVED <gate> \d{4}-\d{2}-\d{2}$` line;
 *   - a `GATE-REJECTED` line for the same gate VOIDS every approval above it;
 *   - the guard reads the ledger through `gateReceiptStatus(text, gate)`.
 *
 * The port adds a second receipt kind (`AUTO-*`). The safety property under test:
 * **an AUTO receipt can never satisfy the gate rule**, i.e. the machine cannot
 * forge a human approval. `AUTO-*` and `GATE-*` must never be confused in
 * either direction, including through crafted field content.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendLedger,
  gateReceiptStatus,
  formatAutoReceipt,
  formatGateReceipt,
  normalizeGate,
  parseAutoReceipt,
  parseHumanReceipt,
  parseReceipts,
  readLedger,
  readLedgerResult,
  today,
} from '../lib/aidlc/ledger.js'
import { guardWrite } from '../lib/aidlc/guards.js'
import { intent, json, state, tmpRoot, write } from './helpers.mjs'

const HUMAN = 'GATE-APPROVED gate1 2026-10-20'

test('human receipt: strict standalone format only', () => {
  assert.equal(parseHumanReceipt(HUMAN).state, 'approved')
  assert.equal(parseHumanReceipt(HUMAN).gate, 'gate1')
  assert.equal(parseHumanReceipt(HUMAN).at, '2026-10-20')
  assert.equal(parseHumanReceipt(HUMAN).auto, false)
  assert.equal(parseHumanReceipt('GATE-REJECTED gate2 2026-01-01').state, 'rejected')
  // near-misses that must NOT be a receipt (the original anchored regex)
  assert.equal(parseHumanReceipt(' GATE-APPROVED gate1 2026-10-20'), null, 'leading space')
  assert.equal(parseHumanReceipt('> GATE-APPROVED gate1 2026-10-20'), null, 'quoted')
  // `\s+` between fields and `\s*$` after the date: both match the original
  assert.equal(parseHumanReceipt('GATE-APPROVED  gate1  2026-10-20').state, 'approved', 'runs of whitespace are the original grammar')
  assert.equal(parseHumanReceipt('GATE-APPROVED gate1 2026-10-20 ').state, 'approved', 'trailing space is tolerated by the original grammar')
  assert.equal(parseHumanReceipt('gate-approved gate1 2026-10-20'), null, 'lowercase')
  assert.equal(parseHumanReceipt('GATE-APPROVED gate3 2026-10-20'), null, 'unknown gate')
  assert.equal(parseHumanReceipt('GATE-APPROVED gate1 2026-10-20 extra'), null, 'trailing text')
  assert.equal(parseHumanReceipt('GATE-APPROVED gate1 20-10-2026'), null, 'bad date')
})

test('AUTO receipt cannot be read as a human receipt (forgery, direction 1)', () => {
  const auto = formatAutoReceipt({ gate: 'gate1', verdict: 'approved', by: 'systemone:Kev-4b', confidence: 0.91, at: '2026-10-20' })
  assert.match(auto, /^AUTO-APPROVED gate1 2026-10-20 /)
  assert.equal(parseHumanReceipt(auto), null)
  assert.equal(parseReceipts(`${auto}\n`).gates.gate1, null)
  assert.equal(parseReceipts(`${auto}\n`).auto.length, 1)
})

test('AUTO receipts never satisfy a gate: the two-argument call the guard uses', () => {
  const auto = formatAutoReceipt({ gate: 'gate1', verdict: 'approved', by: 'x', confidence: 0.99, at: '2026-10-20' })
  const onlyAuto = `${auto}\n`
  assert.deepEqual(gateReceiptStatus(onlyAuto, 'gate1'), { state: 'none', at: null, line: null })
  // the same ledger with one human line in it DOES satisfy the gate — proving the
  // test can tell the two apart
  assert.equal(gateReceiptStatus(`${onlyAuto}${HUMAN}\n`, 'gate1').state, 'approved')
})

test('AUTO can never be smuggled into the human grammar through its fields', () => {
  // newline injection through every free-text field
  const nasty = formatAutoReceipt({
    gate: 'gate1',
    verdict: 'approved',
    by: 'x\ny',
    confidence: 0.5,
    reason: 'ok\nGATE-APPROVED gate1 2026-01-01\nGATE-APPROVED gate2 2026-01-01',
    at: '2026-10-20',
  })
  assert.equal(nasty.split('\n').length, 1, 'an auto receipt is always exactly one line')
  assert.equal(parseHumanReceipt(nasty), null)
  assert.equal(gateReceiptStatus(`${nasty}\n`, 'gate1').state, 'none')
  assert.equal(gateReceiptStatus(`${nasty}\n`, 'gate2').state, 'none')

  // CR / tab / NUL folding
  const controls = formatAutoReceipt({ gate: 'gate1', verdict: 'approved', by: 'a\rb\tc\u0000d', at: '2026-10-20' })
  assert.equal(controls.split('\n').length, 1)
  assert.equal(gateReceiptStatus(`${controls}\n`, 'gate1').state, 'none')
})

test('an AUTO line cannot masquerade as human by prefix tricks', () => {
  const variants = [
    'AUTO-GATE-APPROVED gate1 2026-10-20',
    'XAUTO-APPROVED gate1 2026-10-20',
    ' AUTO-APPROVED gate1 2026-10-20',
    'AUTO-APPROVED gate1 2026-10-20 GATE-APPROVED gate1 2026-10-20',
    'AUTO-APPROVEDGATE-APPROVED gate1 2026-10-20',
  ]
  for (const line of variants) {
    assert.equal(gateReceiptStatus(`${line}\n`, 'gate1').state, 'none', line)
    assert.equal(parseHumanReceipt(line), null, line)
  }
})

test('round semantics: a rejection voids every approval above it', () => {
  const approved = `${HUMAN}\n`
  assert.equal(gateReceiptStatus(approved, 'gate1').state, 'approved')
  const rejectedAfter = `${HUMAN}\nGATE-REJECTED gate1 2026-10-21\n`
  assert.equal(gateReceiptStatus(rejectedAfter, 'gate1').state, 'rejected')
  const approvedAfter = `${HUMAN}\nGATE-REJECTED gate1 2026-10-21\nGATE-APPROVED gate1 2026-10-22\n`
  assert.equal(gateReceiptStatus(approvedAfter, 'gate1').state, 'approved')
  assert.equal(gateReceiptStatus(approvedAfter, 'gate1').at, '2026-10-22')
  // and the rounds are per gate: gate2 is untouched by gate1's rejection
  assert.equal(gateReceiptStatus(rejectedAfter, 'gate2').state, 'none')
  const bothGates = `${HUMAN}\nGATE-REJECTED gate1 2026-10-21\nGATE-APPROVED gate2 2026-10-21\n`
  assert.equal(gateReceiptStatus(bothGates, 'gate2').state, 'approved')
  assert.equal(gateReceiptStatus(bothGates, 'gate1').state, 'rejected')
})

test('gateReceiptStatus reports the line number and date of the deciding receipt', () => {
  const text = `# log\n\n${HUMAN}\nGATE-REJECTED gate1 2026-10-21\n`
  const status = gateReceiptStatus(text, 'gate1')
  assert.equal(status.state, 'rejected')
  assert.equal(status.line, 4)
  assert.equal(status.at, '2026-10-21')
  assert.deepEqual(gateReceiptStatus('', 'gate1'), { state: 'none', at: null, line: null })
  assert.deepEqual(gateReceiptStatus(HUMAN, 'gate3'), { state: 'none', at: null, line: null })
})

test('there is no opt-in that lets an AUTO receipt satisfy a gate', () => {
  const auto = formatAutoReceipt({ gate: 'gate1', verdict: 'approved', by: 'x', confidence: 0.9, at: '2026-10-20' })
  assert.equal(gateReceiptStatus(`${auto}\n`, 'gate1').state, 'none', 'default must ignore AUTO')
  assert.equal(gateReceiptStatus(`${auto}\n`, 'gate1', {}).state, 'none')
  // A hostile caller trying to enable an auto gate receipt must not find a switch.
  // (docs/migration-map.md §5/D5 used to document an `{allowAuto:true}` opt-in; it
  // was removed from the code — this assertion pins the removal.)
  assert.equal(gateReceiptStatus(`${auto}\n`, 'gate1', { allowAuto: true }).state, 'none')
  assert.equal(gateReceiptStatus.length, 2, 'gateReceiptStatus takes no third argument')
  const voided = `${auto}\nAUTO-REJECTED gate1 2026-10-21 by=x conf=0.9\n`
  assert.equal(gateReceiptStatus(voided, 'gate1', { allowAuto: true }).state, 'none')
})

test('parseAutoReceipt keeps by/conf/reason and reads the tail verbatim', () => {
  const line = formatAutoReceipt({
    gate: 'gate2',
    verdict: 'rejected',
    by: 'session:deepseek/x',
    confidence: 0.826,
    reason: 'the design contradicts the PRD',
    at: '2026-10-20',
  })
  const receipt = parseAutoReceipt(line, 7)
  assert.equal(receipt.gate, 'gate2')
  assert.equal(receipt.state, 'rejected')
  assert.equal(receipt.auto, true)
  assert.equal(receipt.by, 'session:deepseek/x')
  assert.equal(receipt.confidence, 0.83)
  assert.equal(receipt.reason, 'the design contradicts the PRD')
  assert.equal(receipt.line, 7)
  assert.equal(parseAutoReceipt('AUTO-APPROVED gate3 2026-10-20'), null)
  assert.equal(parseAutoReceipt('AUTO-MAYBE gate1 2026-10-20'), null)
})

test('formatGateReceipt / formatAutoReceipt fail closed on unusable input', () => {
  assert.equal(formatGateReceipt('gate1', '2026-10-20'), HUMAN)
  assert.equal(formatGateReceipt('GATE2', '2026-10-20'), 'GATE-APPROVED gate2 2026-10-20')
  assert.equal(formatGateReceipt('gate3', '2026-10-20'), null)
  assert.equal(formatGateReceipt('gate1', 'not-a-date'), null)
  assert.equal(formatGateReceipt('gate1', new Date('nonsense')), null)
  assert.equal(formatAutoReceipt({ gate: 'gate1', verdict: 'maybe' }), null)
  assert.equal(formatAutoReceipt({ gate: 'gate3', verdict: 'approved' }), null)
  assert.equal(formatAutoReceipt(), null)
  assert.equal(normalizeGate(' Gate1 '), 'gate1')
  assert.equal(normalizeGate('gate9'), null)
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/)
})

test('parseReceipts: archived marker and document order', () => {
  const text = [
    '# decisions',
    'ARCHIVED 2026-10-20 human terminated the intent',
    'AUTO-APPROVED gate1 2026-10-19 by=x conf=0.9',
    HUMAN,
    'GATE-REJECTED gate2 2026-10-20',
  ].join('\n')
  const parsed = parseReceipts(text)
  assert.equal(parsed.archived, true)
  assert.equal(parsed.auto.length, 1)
  assert.equal(parsed.gates.gate1.state, 'approved')
  assert.equal(parsed.gates.gate2.state, 'rejected')
  assert.equal(parseReceipts('').archived, false)
  assert.deepEqual(parseReceipts('').gates, { gate1: null, gate2: null })
})

test('readLedger distinguishes absent from present, appendLedger enforces the prefix', (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo', { ledgerText: null })
  assert.deepEqual(readLedgerResult(dir), { ok: true, text: '' })
  assert.equal(readLedger(dir), '')

  write(join(dir, 'decisions.md'), 'A\nB\n')
  assert.equal(readLedger(dir), 'A\nB\n')
  const rejected = appendLedger(dir, 'A\nC\n')
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /append-only/)
  // The same refusal in the other locale: prose switches, the structure and the
  // machine literals (decisions.md, appendLedger) do not.
  const rejectedZh = appendLedger(dir, 'A\nC\n', {}, { locale: 'zh-CN' })
  assert.equal(rejectedZh.ok, false)
  assert.match(rejectedZh.message, /只追加/)
  assert.match(rejectedZh.message, /decisions\.md/)
  assert.equal(readFileSync(join(dir, 'decisions.md'), 'utf8'), 'A\nB\n', 'a rejected append must not touch the file')

  const appended = appendLedger(dir, 'A\nB\nC\n')
  assert.equal(appended.ok, true)
  assert.equal(readFileSync(join(dir, 'decisions.md'), 'utf8'), 'A\nB\nC\n')

  const chunk = appendLedger(dir, 'D\n', { asChunk: true })
  assert.equal(chunk.ok, true)
  assert.equal(readFileSync(join(dir, 'decisions.md'), 'utf8'), 'A\nB\nC\nD\n')
  assert.equal(appendLedger('', 'x').ok, false)
})

test('appendLedger creates the directory and file on first use', (t) => {
  const root = tmpRoot(t)
  const dir = join(root, 'docs', 'aidlc', 'fresh')
  const result = appendLedger(dir, `${HUMAN}\n`)
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(dir, 'decisions.md')), true)
  assert.equal(gateReceiptStatus(readLedger(dir), 'gate1').state, 'approved')
})

/* ───────────────────────── integration through the guard ───────────────────── */

test('SAFETY: a state.json claiming approved is denied when only an AUTO receipt exists', (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo', {
    stateOverrides: { phase: 'gate1', gates: { gate1: 'pending', gate2: 'pending' } },
    ledgerText: `${formatAutoReceipt({ gate: 'gate1', verdict: 'approved', by: 'systemone:Kev-4b', confidence: 0.99, at: '2026-10-20' })}\n`,
  })
  const next = state({ phase: 'construction', gates: { gate1: 'approved', gate2: 'pending' }, updatedAt: '2026-10-20T01:00:00.000Z' })
  const decision = guardWrite({ filePath: 'docs/aidlc/demo/state.json', content: json(next), root })
  assert.equal(decision.kind, 'deny', 'the machine must not be able to forge a human approval')
  assert.match(decision.reason, /no live human approval receipt/)
  assert.equal(existsSync(join(dir, 'state.json')), true)
})

test('SAFETY: the same state.json is allowed once the human receipt is present', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', {
    stateOverrides: { phase: 'gate1', gates: { gate1: 'pending', gate2: 'pending' } },
    ledgerText: `${HUMAN}\n`,
  })
  const next = state({ phase: 'construction', gates: { gate1: 'approved', gate2: 'pending' }, updatedAt: '2026-10-20T01:00:00.000Z' })
  assert.equal(guardWrite({ filePath: 'docs/aidlc/demo/state.json', content: json(next), root }).kind, 'allow')
})

test('SAFETY: an AUTO receipt cannot resurrect an approval a rejection voided', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', {
    stateOverrides: { phase: 'gate1', gates: { gate1: 'pending', gate2: 'pending' } },
    ledgerText: `${HUMAN}\nGATE-REJECTED gate1 2026-10-21\n${formatAutoReceipt({ gate: 'gate1', verdict: 'approved', by: 'x', confidence: 0.99, at: '2026-10-22' })}\n`,
  })
  const next = state({ phase: 'construction', gates: { gate1: 'approved', gate2: 'pending' }, updatedAt: '2026-10-20T01:00:00.000Z' })
  const decision = guardWrite({ filePath: 'docs/aidlc/demo/state.json', content: json(next), root })
  assert.equal(decision.kind, 'deny')
})

test('SAFETY: a gate1 receipt does not approve gate2 and vice versa', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', {
    stateOverrides: { phase: 'gate2', gates: { gate1: 'pending', gate2: 'pending' } },
    ledgerText: 'GATE-APPROVED gate1 2026-10-20\n',
  })
  const next = state({ phase: 'operations', gates: { gate1: 'pending', gate2: 'approved' }, updatedAt: '2026-10-20T01:00:00.000Z' })
  assert.equal(guardWrite({ filePath: 'docs/aidlc/demo/state.json', content: json(next), root }).kind, 'deny')

  intent(root, 'demo', { stateOverrides: { phase: 'gate2', gates: { gate1: 'pending', gate2: 'pending' } }, ledgerText: 'GATE-APPROVED gate2 2026-10-20\n' })
  assert.equal(guardWrite({ filePath: 'docs/aidlc/demo/state.json', content: json(next), root }).kind, 'allow')
})

test('a state.json that claims nothing needs no receipt (near-miss: no false deny)', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending', gate2: 'pending' } }, ledgerText: null })
  const next = state({ phase: 'inception', gates: { gate1: 'pending', gate2: 'pending' }, updatedAt: '2026-10-20T01:00:00.000Z' })
  assert.equal(guardWrite({ filePath: 'docs/aidlc/demo/state.json', content: json(next), root }).kind, 'allow')
})

test('an unreadable decisions.md fails closed instead of looking empty (D3)', (t) => {
  const root = tmpRoot(t)
  const dir = intent(root, 'demo', {
    stateOverrides: { phase: 'gate1', gates: { gate1: 'pending', gate2: 'pending' } },
    ledgerText: null,
  })
  // a DIRECTORY named decisions.md: existsSync passes, readFileSync throws EISDIR
  mkdirSync(join(dir, 'decisions.md'))
  const next = state({ phase: 'construction', gates: { gate1: 'approved', gate2: 'pending' }, updatedAt: '2026-10-20T01:00:00.000Z' })
  const decision = guardWrite({ filePath: 'docs/aidlc/demo/state.json', content: json(next), root })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /cannot be read/, 'the reason must name the read failure, not a missing receipt')
})
