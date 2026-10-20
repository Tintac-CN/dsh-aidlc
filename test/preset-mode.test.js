/**
 * Preset-mode coverage.
 *
 * This file exists because the mode shipped **completely untested** and was
 * therefore **permanently inert**: `currentPresetId` read the projection through
 * a bare `ctx.sessionProjections`, which throws in Cordis for any service the
 * plugin did not declare in `inject` — and it threw *before* the `??` fallback
 * could run, so the catch returned `null` and `isAidlcMode()` was always false.
 * The preset installed, the picker showed it, and selecting it did nothing.
 *
 * The test that would have caught it is the one below whose stub `ctx` **throws
 * on a bare property read**. A stub that merely returns `undefined` for the bare
 * spelling passes against the broken code, because it never exercises the throw —
 * which is exactly why the bug survived review.
 *
 * @module dsh-aidlc/test/preset-mode
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AIDLC_PRESET_ID, PRESET_PROJECTION, currentPresetId, installPreset, isAidlcMode } from '../lib/presets.js'

/** A session stand-in: only identity matters, the registry keys off the object. */
const SESSION = { id: 'session-for-tests' }
const agentFor = (session = SESSION) => ({ session })

/**
 * A `ctx` whose BARE service properties throw, exactly as Cordis does for a
 * service the calling plugin did not `inject`. Only `ctx.get(name)` resolves.
 *
 * @param {Record<string, unknown>} services - what `ctx.get` should return.
 * @param {{ bareThrows?: boolean }} [options]
 */
function ctxWithOnlyGet(services, options = {}) {
  const bareThrows = options.bareThrows !== false
  const ctx = { get: (name) => services[name] }
  for (const name of Object.keys(services)) {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      configurable: true,
      get() {
        if (bareThrows) throw new Error(`cannot get property "${name}" without inject`)
        return services[name]
      },
    })
  }
  return ctx
}

/** A registry stub answering one preset id for the projection key. */
const registryFor = (value) => ({ stateOf: (session, key) => (key === PRESET_PROJECTION ? value : undefined) })

// ───────────────────────────────────────────────────────────── mode detection

test('reads the projection through ctx.get alone, with bare properties that THROW', () => {
  // The regression guard. A `??`-fallback implementation cannot pass this: the
  // bare getter throws before the fallback is reached.
  const ctx = ctxWithOnlyGet({ sessionProjections: registryFor('aidlc') }, { bareThrows: true })
  assert.equal(currentPresetId(ctx, agentFor()), 'aidlc')
  assert.equal(isAidlcMode(ctx, agentFor()), true)
})

test('still reads it when bare properties merely return undefined (liberal stub)', () => {
  const ctx = ctxWithOnlyGet({ sessionProjections: registryFor('aidlc') }, { bareThrows: false })
  assert.equal(isAidlcMode(ctx, agentFor()), true)
})

test('preset id "aidlc" is the mode, and nothing else is', () => {
  for (const [value, expected] of [
    ['aidlc', true],
    ['standard', false],
    ['ptc', false],
    ['AIDLC', false], // ids are case-sensitive
    ['aidlc-mode', false], // no prefix matching
    [null, false],
    [undefined, false],
    [42, false],
  ]) {
    const ctx = ctxWithOnlyGet({ sessionProjections: registryFor(value) })
    assert.equal(isAidlcMode(ctx, agentFor()), expected, `projection ${JSON.stringify(value)}`)
    // `currentPresetId` reports WHATEVER id the session runs — a non-mode preset id
    // is not null, it is simply not the mode. Only a non-string is null.
    const expectedId = typeof value === 'string' ? value : null
    assert.equal(currentPresetId(ctx, agentFor()), expectedId, `currentPresetId for ${JSON.stringify(value)}`)
  }
})

test('a wrapped projection shape is tolerated, because the docs only promise a string today', () => {
  // The projection is a bare id (`string | null`) as shipped. The reader is
  // deliberately liberal about a future wrapper, and this pins that decision so
  // it is a choice rather than an accident.
  for (const wrapped of [{ presetId: 'aidlc' }, { id: 'aidlc' }, { agentPreset: 'aidlc' }]) {
    const ctx = ctxWithOnlyGet({ sessionProjections: registryFor(wrapped) })
    assert.equal(isAidlcMode(ctx, agentFor()), true, JSON.stringify(wrapped))
  }
  // A wrapper naming something else is still not the mode.
  const ctx = ctxWithOnlyGet({ sessionProjections: registryFor({ presetId: 'standard' }) })
  assert.equal(isAidlcMode(ctx, agentFor()), false)
})

test('no registry at all -> false, and it does not throw', () => {
  // A composition without the roster: ctx.get answers undefined.
  const ctx = ctxWithOnlyGet({})
  assert.doesNotThrow(() => isAidlcMode(ctx, agentFor()))
  assert.equal(isAidlcMode(ctx, agentFor()), false)
  assert.equal(currentPresetId(ctx, agentFor()), null)
})

test('ctx.get itself throwing -> false, never a throw', () => {
  const ctx = { get: () => { throw new Error('registry exploded') } }
  assert.doesNotThrow(() => isAidlcMode(ctx, agentFor()))
  assert.equal(isAidlcMode(ctx, agentFor()), false)
})

test('a throwing stateOf -> false, never a throw', () => {
  const ctx = ctxWithOnlyGet({ sessionProjections: { stateOf: () => { throw new Error('projection exploded') } } })
  assert.doesNotThrow(() => isAidlcMode(ctx, agentFor()))
  assert.equal(isAidlcMode(ctx, agentFor()), false)
})

test('a registry with no stateOf -> false', () => {
  const ctx = ctxWithOnlyGet({ sessionProjections: {} })
  assert.equal(isAidlcMode(ctx, agentFor()), false)
})

test('a missing ctx or agent -> false, never a throw', () => {
  assert.equal(currentPresetId(undefined, agentFor()), null)
  assert.equal(currentPresetId(null, agentFor()), null)
  assert.equal(isAidlcMode(undefined, undefined), false)
  assert.equal(isAidlcMode(ctxWithOnlyGet({ sessionProjections: registryFor('aidlc') }), undefined), false)
  assert.equal(isAidlcMode(ctxWithOnlyGet({ sessionProjections: registryFor('aidlc') }), {}), false)
  assert.equal(isAidlcMode(ctxWithOnlyGet({ sessionProjections: registryFor('aidlc') }), { session: null }), false)
})

test('the projection key it asks for is the documented one', () => {
  const asked = []
  const ctx = { get: () => ({ stateOf: (session, key) => { asked.push(key); return null } }) }
  currentPresetId(ctx, agentFor())
  assert.deepEqual(asked, ['agentPreset'])
  assert.equal(PRESET_PROJECTION, 'agentPreset')
})

// ──────────────────────────────────────────────────────────────── installer

/** Run a body against a fresh temp dshHome, always cleaning up. */
function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'aidlc-preset-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const silentLog = () => {
  const lines = []
  return { lines, warn: (m) => lines.push(`warn: ${m}`), info: (m) => lines.push(`info: ${m}`), error: (m) => lines.push(`error: ${m}`) }
}
const presetDir = (home) => join(home, '.agent-presets', AIDLC_PRESET_ID)
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : [])
/** Content of every generated file, keyed by name. */
function contentsOf(dir) {
  const out = {}
  for (const name of filesIn(dir)) out[name] = readFileSync(join(dir, name), 'utf8')
  return out
}

test('installer: first write creates both files, marked as generated', () => {
  withTempHome((home) => {
    const log = silentLog()
    const result = installPreset({ dshHome: home, log })
    assert.equal(result.installed, true, JSON.stringify(result))
    const dir = presetDir(home)
    const names = filesIn(dir)
    assert.ok(names.includes('preset.yml'), `expected preset.yml in ${JSON.stringify(names)}`)
    assert.ok(names.includes('agent.cordis.yml'), `expected agent.cordis.yml in ${JSON.stringify(names)}`)
    for (const [name, text] of Object.entries(contentsOf(dir))) {
      assert.match(text, /generated-by: dsh-aidlc/, `${name} must carry the ownership marker`)
      assert.ok(text.length > 0)
    }
    assert.equal(log.lines.filter((l) => l.startsWith('warn')).length, 0, 'a clean first install must not warn')
  })
})

test('installer: a second run is idempotent and rewrites nothing', () => {
  withTempHome((home) => {
    const first = installPreset({ dshHome: home, log: silentLog() })
    assert.equal(first.installed, true)
    const dir = presetDir(home)
    const before = contentsOf(dir)
    const mtimes = Object.fromEntries(filesIn(dir).map((n) => [n, statSync(join(dir, n)).mtimeMs]))
    // A sleep would be flaky; instead assert the returned shape says "unchanged".
    const second = installPreset({ dshHome: home, log: silentLog() })
    assert.equal(second.installed, true, JSON.stringify(second))
    assert.deepEqual(contentsOf(dir), before, 'content must be byte-identical after a second run')
    assert.equal(first.written !== undefined && second.written !== undefined && second.written.length > first.written.length, false,
      'the second run must not report more writes than the first')
    for (const [n, m] of Object.entries(mtimes)) assert.equal(statSync(join(dir, n)).mtimeMs, m, `${n} must not be rewritten`)
  })
})

test('installer: an upgrade refreshes OUR file and keeps the marker', () => {
  withTempHome((home) => {
    assert.equal(installPreset({ dshHome: home, log: silentLog() }).installed, true)
    const dir = presetDir(home)
    const target = join(dir, 'preset.yml')
    // Simulate an older version's file: still ours (marker present), stale body.
    writeFileSync(target, '# generated-by: dsh-aidlc preset installer\n# stale\nname: STALE\n', 'utf8')
    const log = silentLog()
    const result = installPreset({ dshHome: home, log })
    assert.equal(result.installed, true, JSON.stringify(result))
    const refreshed = readFileSync(target, 'utf8')
    assert.doesNotMatch(refreshed, /STALE/, 'our own stale file must be refreshed on upgrade')
    assert.match(refreshed, /generated-by: dsh-aidlc/)
    assert.deepEqual(result.written, ['preset.yml'], 'the upgrade must report rewriting our stale file')
  })
})

test('installer: a user-owned preset is left COMPLETELY alone, with no partial install', () => {
  withTempHome((home) => {
    const dir = presetDir(home)
    mkdirSync(dir, { recursive: true })
    const mine = '# hand-written by the user, no marker\nname: my own aidlc\n'
    writeFileSync(join(dir, 'preset.yml'), mine, 'utf8')
    // A second file that is ours, to prove one foreign file aborts the WHOLE install.
    const log = silentLog()
    const result = installPreset({ dshHome: home, log })
    assert.equal(result.installed, false, 'installing over a user-owned preset must not report success')
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), mine, 'the user\'s file must be untouched')
    assert.deepEqual(filesIn(dir), ['preset.yml'], 'a foreign file must abort before writing ANY other file')
    assert.ok(log.lines.some((l) => l.startsWith('warn')), 'the refusal must be loud')
  })
})

test('installer: a user-owned file does not block an explicit force', () => {
  withTempHome((home) => {
    const dir = presetDir(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'preset.yml'), 'name: my own aidlc\n', 'utf8')
    const result = installPreset({ dshHome: home, log: silentLog(), force: true })
    assert.equal(result.installed, true, JSON.stringify(result))
    assert.match(readFileSync(join(dir, 'preset.yml'), 'utf8'), /generated-by: dsh-aidlc/)
  })
})

test('installer: never throws, even for an unusable dshHome', () => {
  const log = silentLog()
  assert.doesNotThrow(() => installPreset({ dshHome: join(tmpdir(), 'aidlc-preset-\u0000-invalid'), log }))
  assert.doesNotThrow(() => installPreset({ dshHome: undefined, log }))
})
