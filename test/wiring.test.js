/**
 * The real wiring, booted against a mock Cordis context.
 *
 * This is the one place the suite touches `lib/index.js` — a guarded dynamic
 * import, skipped with a message when the harness packages are absent. It pins
 * the D10 closure: the guard layer must not switch itself off when the agent
 * carries no `session.header.cwd` (it now falls back to `process.cwd()` and
 * still denies).
 *
 * NOT covered here: the harness's own question service, `ctx.llm`, the skill
 * registry (the mock's `ctx.skills` shape is intentionally not the real one),
 * and anything requiring a live composition.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRoot } from './helpers.mjs'

/** Boot the plugin with the smallest context that satisfies `apply`. */
async function boot(t, { config = {}, cwd } = {}) {
  let mod
  try {
    mod = await import('../lib/index.js')
  } catch (error) {
    t.skip(`harness packages unavailable (${error.message.split('\n')[0]})`)
    return null
  }
  const listeners = new Map()
  const commands = []
  const tools = []
  const warnings = []
  const errors = []
  const log = { warn: (...a) => warnings.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')), info: () => {} }
  const ctx = {
    logger: () => log,
    on: (event, handler) => listeners.set(event, handler),
    effect: () => {},
    get: () => undefined,
    commands: { register: (c) => commands.push(c) },
    tools: { register: (tool) => tools.push(tool), get: () => undefined },
  }
  const originalCwd = process.cwd()
  if (cwd !== undefined) process.chdir(cwd)
  mod.apply(ctx, config)
  return {
    listeners,
    commands,
    tools,
    warnings,
    errors,
    /** Restore the process cwd; call this before the temp-dir cleanup runs. */
    release: () => process.chdir(originalCwd),
    call: (exec, agent) => listeners.get('tools/pre-execute')({ callId: 'c1', agent, ...exec }, async () => ({ kind: 'enter' })),
  }
}

test('the plugin boots and registers the documented surface', async (t) => {
  const root = tmpRoot(t)
  const wired = await boot(t, { cwd: root })
  if (wired === null) return
  assert.deepEqual([...wired.listeners.keys()], [
    'tools/pre-execute',
    'tools/post-execute',
    'agent/session-start',
    // `agent/created` / `agent/disposed` carry the AIDLC-mode prompt section:
    // it is registered per agent (the shipped precedent for a plugin mounted
    // outside a preset) and must be disposed with that agent.
    'agent/created',
    'agent/disposed',
    'agent/pre-step',
    'user-questions/request',
  ])
  assert.equal(wired.tools.length, 4, 'aidlc_status / aidlc_classify / aidlc_decide / aidlc_record_decision')
  // 13 lifecycle commands plus `aidlc-doctor`, the read-only self-check.
  assert.equal(wired.commands.length, 14)
  assert.deepEqual(wired.errors, [], 'booting with a usable config logs no error')
  wired.release()
})

test('D10 CLOSED: with no session cwd the guards still fire (process.cwd() fallback)', async (t) => {
  const root = tmpRoot(t)
  mkdirSync(join(root, 'docs', 'aidlc', 'demo'), { recursive: true })
  writeFileSync(
    join(root, 'docs', 'aidlc', 'demo', 'state.json'),
    JSON.stringify({ slug: 'demo', phase: 'construction', gates: { gate1: 'approved' }, tddLock: true, tddLockPaths: [], history: [], updatedAt: '2026-10-20T00:00:00Z' }),
  )
  const wired = await boot(t, { cwd: root })
  if (wired === null) return
  try {
    // THE ATTACK that used to succeed: an agent whose session header carries no
    // cwd. Before D10's fix the listener returned next() and EVERY guard was off.
    const noCwd = { session: { header: {} } }
    const noSession = {}
    const secret = { name: 'write', arguments: { file_path: '.env', content: 'K=v' } }
    for (const [label, agent] of [['empty header', noCwd], ['no session at all', noSession]]) {
      const denied = await wired.call(secret, agent)
      assert.equal(denied.kind, 'deny', label)
      assert.match(denied.reason, /environment\/secret file/)
    }
    // ...and the intent-aware rules still fire too
    const locked = await wired.call({ name: 'edit', arguments: { file_path: 'src/a.test.js' } }, noCwd)
    assert.equal(locked.kind, 'deny')
    assert.match(locked.reason, /TDD 锁生效/)
    // the fallback is announced once, not silently
    assert.equal(wired.warnings.some((w) => /falling back to the process working directory/.test(w)), true)
  } finally {
    wired.release()
  }
})

test('a write-shaped call with no recognizable path is allowed but announced', async (t) => {
  const root = tmpRoot(t)
  const wired = await boot(t, { cwd: root })
  if (wired === null) return
  try {
    const result = await wired.call({ name: 'write', arguments: { path_hint: 'unknown-tool-arg' } }, { session: { header: { cwd: root } } })
    assert.equal(result.kind, 'enter', 'there is nothing to match on, so it cannot be denied')
    assert.equal(wired.warnings.some((w) => /carried no recognizable path argument/.test(w)), true, 'and it must not pass in silence')
  } finally {
    wired.release()
  }
})

test('a guard that throws is never a silent allow', async (t) => {
  const root = tmpRoot(t)
  const wired = await boot(t, { cwd: root })
  if (wired === null) return
  try {
    // a getter that throws on read makes the listener itself fail
    const hostile = { name: 'write', callId: 'x', get arguments() { throw new Error('boom') }, agent: { session: { header: { cwd: root } } } }
    // the only safe outcomes are "deny" or "the call fails"; it must never enter
    let outcome
    try {
      outcome = await wired.listeners.get('tools/pre-execute')(hostile, async () => ({ kind: 'enter' }))
    } catch (error) {
      outcome = { kind: 'threw', error }
    }
    assert.notEqual(outcome.kind, 'enter', 'a guard that could not evaluate must not let the write through')
  } finally {
    wired.release()
  }
})
