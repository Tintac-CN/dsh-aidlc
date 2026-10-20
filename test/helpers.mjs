/**
 * Shared fixtures for the dsh-aidlc regression suite.
 *
 * Every helper here builds a throwaway `docs/aidlc/<slug>/` tree under the OS
 * temp directory. Nothing in `test/` writes inside the repository, touches the
 * network, or needs a running harness: the modules under test are the
 * harness-free `lib/aidlc/*` and `lib/decision/*`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A workspace root that cleans itself up when the test ends. */
export function tmpRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aidlc-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** `docs/aidlc/<slug>` under a root, created on demand. */
export function intentDir(root, slug) {
  const dir = join(root, 'docs', 'aidlc', slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a file, creating parent directories. */
export function write(file, text) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return file
}

/** JSON with 2-space indent, as the Write tool would send it. */
export function json(value) {
  return JSON.stringify(value, null, 2)
}

/** A plausible `state.json` body. Override anything. */
export function state(overrides = {}) {
  return {
    slug: 'demo',
    intent: 'demo intent',
    phase: 'construction',
    gates: { gate1: 'approved', gate2: 'pending' },
    tddLock: false,
    tddLockPaths: [],
    tddLockOverride: null,
    testBaseline: null,
    updatedAt: '2026-10-20T00:00:00.000Z',
    history: [{ at: '2026-10-19T00:00:00.000Z', event: 'created' }],
    route: 'classic',
    ...overrides,
  }
}

/** `docs/aidlc/<slug>/state.json` + `decisions.md`, with a sane default ledger. */
export function intent(root, slug, { stateOverrides = {}, ledgerText = 'GATE-APPROVED gate1 2026-10-20\n' } = {}) {
  const dir = intentDir(root, slug)
  write(join(dir, 'state.json'), json(state({ slug, ...stateOverrides })))
  if (ledgerText !== null) write(join(dir, 'decisions.md'), ledgerText)
  return dir
}

/** A PRD with sub-numbered acceptance criteria. */
export function prd(text = '## 验收标准（可测）\n- AC1.1 first\n- AC1.2 second\n') {
  return `# PRD\n\n${text}`
}

/** A test strategy whose 映射 AC column maps every given token. */
export function testStrategy(tokens = ['AC1.1', 'AC1.2']) {
  return [
    '# Test strategy',
    '',
    '## 测试点清单',
    '',
    '| 场景 | 测试点 | 映射 AC |',
    '|---|---|---|',
    ...tokens.map((token, i) => `| scene ${i} | point ${i} | ${token} |`),
    '',
  ].join('\n')
}

/** An in-memory `consultModel` fake; counts its calls. */
export function modelFake(answer) {
  const fake = async () => answer
  fake.calls = 0
  const wrapped = async (...args) => {
    fake.calls += 1
    return typeof answer === 'function' ? answer(fake.calls, ...args) : answer
  }
  wrapped.calls = () => fake.calls
  return wrapped
}

/** A `deps` bag whose `askHuman` throws: any accidental human race fails the test loudly. */
export function deps({ consultModel, record, now = () => 1_700_000_000_000, extra = {} } = {}) {
  return {
    askHuman: () => {
      throw new Error('askHuman must never be called by the decision layer (no human race)')
    },
    consultModel: consultModel ?? (async () => ({ choice: 'Approve', confidence: 0.95, risk: 'low' })),
    record: record ?? (() => {}),
    now,
    ...extra,
  }
}
