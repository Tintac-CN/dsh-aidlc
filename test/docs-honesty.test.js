/**
 * Documentation honesty — does `docs/` and `README.md` assert a guarantee the
 * frozen `lib/` does not provide, or omit one it does?
 *
 * The mechanical checks here (exports exist, command names resolve, the frozen
 * interface names are real) are green. The overclaim checks are DEFECT pins and
 * are expected red; see test/known-defects.test.js for the same findings.
 *
 * The two claims that matter most, both from the task brief:
 *   - "hooks are process constraints, not a security boundary" must be stated;
 *   - the read-only-reviewer guarantee is a known regression and must be
 *     disclosed with its limit (tool-read-only, not capability-isolated).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import * as guards from '../lib/aidlc/guards.js'
import * as state from '../lib/aidlc/state.js'
import * as ledger from '../lib/aidlc/ledger.js'
import * as coverage from '../lib/aidlc/coverage.js'
import * as baseline from '../lib/aidlc/baseline.js'
import * as impact from '../lib/aidlc/impact.js'
import * as policy from '../lib/decision/policy.js'
import * as arbiter from '../lib/decision/arbiter.js'
import * as classify from '../lib/decision/classify.js'
import * as audit from '../lib/decision/audit.js'
import * as reviewer from '../lib/decision/reviewer.js'
import * as systemone from '../lib/decision/systemone.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
/** Strip block and line comments so a scan finds USER-VISIBLE strings only. */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('the frozen interfaces of docs/design.md §4.2–§4.6 and §4.7–§4.11 exist as functions', () => {
  const contract = {
    'lib/aidlc/state.js': [state, ['readJson', 'findActiveIntent', 'loadIntent', 'slugOfPath', 'isTestFile', 'isAidlcArtifactPath', 'newState', 'writeState', 'checkOverwrite', 'readAutoRouteConfig', 'writeAutoRouteConfig', 'nowIso']],
    'lib/aidlc/ledger.js': [ledger, ['readLedger', 'appendLedger', 'parseReceipts', 'gateReceiptStatus', 'formatGateReceipt', 'formatAutoReceipt']],
    'lib/aidlc/guards.js': [guards, ['guardPaths', 'guardWrite', 'guardTestsPostWrite', 'slugForGuard']],
    'lib/aidlc/coverage.js': [coverage, ['extractAcceptanceCriteria', 'extractTestPointMap', 'checkCoverage']],
    'lib/aidlc/baseline.js': [baseline, ['parseTestOutput', 'recordBaseline', 'compareBaseline']],
    'lib/decision/policy.js': [policy, ['resolveMode', 'isSubstitutable']],
    'lib/decision/classify.js': [classify, ['classify']],
    'lib/decision/arbiter.js': [arbiter, ['arbitrate']],
    'lib/decision/systemone.js': [systemone, ['callSystemone']],
    'lib/decision/audit.js': [audit, []],
    'lib/decision/reviewer.js': [reviewer, []],
    'lib/aidlc/impact.js': [impact, ['scanUnitImpact', 'scanUnits', 'formatImpactCell', 'parseImpactCell', 'summarizeImpact', 'listRepoFiles', 'deriveModuleSpecifiers']],
  }
  for (const [file, [mod, names]] of Object.entries(contract)) {
    for (const name of names) assert.equal(typeof mod[name], 'function', `${file} must export ${name}()`)
  }
  // the additive exports migration-map §5/D7 promises
  for (const name of ['listIntents', 'activeIntentSummary', 'routeEcho', 'armVeto', 'resolveVeto', 'isVetoPending', 'PRESERVE_KEYS']) {
    assert.ok(name in state, `state.js must export ${name}`)
  }
  assert.equal(typeof ledger.readLedgerResult, 'function', 'readLedgerResult lives in ledger.js')
  for (const name of ['parseAutoReceipt', 'parseHumanReceipt', 'normalizeGate', 'today']) assert.equal(typeof ledger[name], 'function', name)
  assert.equal(typeof coverage.splitTableRow, 'function')
  assert.equal(typeof baseline.buildBaseline, 'function')
  assert.equal(typeof policy.NEVER_AUTO?.has, 'function')
  assert.equal(typeof policy.DEFAULT_DECISION_CONFIG, 'object')
})

test('every /aidlc-* command named in a user-visible message is actually registered', () => {
  const registered = new Set([...code('lib/surface/commands.js').matchAll(/add\('(aidlc-[a-z-]+)'/g)].map((m) => m[1]))
  assert.ok(registered.size >= 12, `expected the command surface, found ${registered.size}`)
  const sources = ['lib/aidlc/guards.js', 'lib/aidlc/state.js', 'lib/aidlc/coverage.js', 'lib/aidlc/ledger.js', 'lib/surface/tools.js', 'lib/surface/context.js', 'lib/surface/commands.js']
  const mentioned = new Set()
  for (const file of sources) {
    for (const m of code(file).matchAll(/\/aidlc-([a-z][a-z0-9-]*)/g)) mentioned.add(`aidlc-${m[1]}`)
  }
  for (const name of mentioned) {
    assert.equal(registered.has(name), true, `${name} is advised to the user but never registered`)
  }
})

test('no user-visible message tells the user to run an unregisterable /aidlc: command', () => {
  // dsh-commands validates names against /^[a-z][a-z0-9_-]*$/u and its parser
  // requires end-of-input or whitespace after the name, so a colon spelling can
  // never be typed (migration-map §5/D13). Comments may mention the old spelling.
  for (const file of ['lib/aidlc/guards.js', 'lib/surface/commands.js', 'lib/surface/context.js']) {
    const offenders = [...code(file).matchAll(/\/aidlc:[a-z-]+/g)].map((m) => m[0])
    assert.deepEqual(offenders, [], `${file} advises a colon-spelled command`)
  }
})

test('migration-map D5 matches the frozen ledger: no allowAuto, AUTO gated on the armed mode', () => {
  const map = read('docs/migration-map.md')
  // The heading was reworded when the gate became armable: AUTO receipts are no
  // longer "recognized" unconditionally — they satisfy a gate ONLY when
  // `gate.approval` is armed. Match the stable stem so the pin asserts the topic
  // is documented without freezing one wording.
  assert.match(map, /D5 — AUTO receipts/)
  assert.match(map, /deleted/)
  assert.equal(ledger.gateReceiptStatus.length, 2, 'the 2-arg signature the map documents')
  assert.equal(/allowAuto/.test(read('lib/aidlc/ledger.js')), false, 'no allowAuto branch may remain in the code')
})

test('migration-map D12 matches the frozen guards: a stateless intent denies Construction artifacts', () => {
  const map = read('docs/migration-map.md')
  assert.match(map, /D12 — Rule 1 also covers the state-less intent directory/)
  assert.match(map, /Edit included/)
  assert.equal(/N8 — CLOSED by D12/.test(map), true, 'N8 must be recorded as closed, not as an accepted gap')
  assert.equal(/believed\s+wrong/.test(map), false, 'the old "believed wrong but preserved" wording must be gone')
  assert.match(read('lib/aidlc/guards.js'), /D12 \(port deviation\)/)
})

test('the "not a security boundary" admission is present where the brief requires it', () => {
  for (const file of ['README.md', 'docs/design.md', 'docs/decision-model.md']) {
    assert.match(read(file), /not a security boundary|不是安全边界|security boundary/i, `${file} must state the limit`)
  }
  assert.match(read('skills/aidlc/SKILL.md'), /not a security boundary|shell redirect|Bash/i)
  assert.match(read('lib/aidlc/guards.js'), /not a security boundary/)
})

test('the read-only-reviewer guarantee is described with its limit, not overclaimed', () => {
  const candidates = ['README.md', 'docs/migration-map.md', 'skills/party-review/SKILL.md', 'skills/aidlc/SKILL.md', 'cordis.patch.yml']
  for (const file of candidates) {
    const text = read(file)
    if (!/subagent_reviewer/.test(text)) continue
    assert.match(text, /tool-read-only|tool-scoped|cannot write|refuse to execute/, `${file} must describe the mechanism`)
    assert.match(text, /not capability-isolated|not in a separate security domain|shares the parent/, `${file} must state the limit`)
  }
  assert.match(read('cordis.patch.yml'), /toolFilter:/)
  assert.match(read('cordis.patch.yml'), /allow:/)
  // the allow-list must not contain a write path
  const allowBlock = /allow:\s*\n((?:\s*-\s*\S+\n)+)/.exec(read('cordis.patch.yml'))
  assert.ok(allowBlock !== null, 'the allow-list must be present')
  for (const forbidden of ['write', 'edit', 'pwsh', 'bash', 'subagent', 'workflow']) {
    assert.equal(new RegExp(`-\\s*${forbidden}\\b`).test(allowBlock[1]), false, `${forbidden} must not be allow-listed for reviewers`)
  }
})

test('package.json advertises a test script that matches the suite layout', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts.test, /node --test/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(existsSync(join(root, 'cordis.patch.yml')), true)
})

test('D1 CLOSED (docs): the receipt claims match what the code now does', () => {
  const text = read('docs/decision-model.md')
  // the overclaim is gone...
  assert.equal(/no code in this plugin may ever write one/.test(text), false, 'the plugin cannot promise unforgeability')
  // ...and the docs now say what the tool actually refuses to do
  assert.match(text, /cannot write|never write|refus/i)
  // the tool layer no longer authors a human receipt at all
  const tools = read('lib/surface/tools.js')
  assert.equal(/ledger\.formatGateReceipt|deps\.ledger\.formatGateReceipt/.test(tools), false, 'the record tool must not call the human-receipt formatter')
  // and the operator-facing text says so unambiguously
  assert.match(read('lib/surface/commands.js'), /cannot write a receipt at all/)
  assert.equal(/machine never writes `GATE-APPROVED`/.test(read('skills/aidlc/SKILL.md')), false, 'SKILL.md no longer needs the absolute claim')
})

test('docs/design.md §7 records the post-review corrections the code implements', () => {
  const design = read('docs/design.md')
  assert.match(design, /## 7\. Corrections applied after review/)
  assert.match(design, /Point A/)
  assert.match(design, /Point B/)
  assert.match(design, /p_max/)
  assert.match(design, /The machine must never write `GATE-APPROVED`/)
  // the superseded race design must not come back in code
  const arbiterText = read('lib/decision/arbiter.js')
  assert.equal(/askHuman\(/.test(arbiterText), false, 'arbitrate() must never call askHuman (no human race)')
})

test('README lists a layout that exists', () => {
  const readme = read('README.md')
  for (const file of ['lib/index.js', 'lib/config.js', 'docs/design.md', 'docs/decision-model.md', 'docs/migration-map.md', 'test']) {
    assert.equal(readme.includes(file.split('/').pop()), true, `README should mention ${file}`)
  }
  assert.equal(existsSync(join(root, 'test')), true)
})
