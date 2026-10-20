/**
 * `guard-paths.mjs` and `guard-tests.mjs` — the two rules that were their own
 * hook processes in the original.
 *
 * Re-derived from the original pattern tables. Every pattern gets a deny case, an
 * allow case and at least one near-miss that must NOT match (the original had
 * several: `.env.example`, dotless `keystore`, `app.pem.bak`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { guardPaths, guardTestsPostWrite } from '../lib/aidlc/guards.js'
import { intent, tmpRoot } from './helpers.mjs'

const deny = (fp) => assert.equal(guardPaths({ filePath: fp }).kind, 'deny', fp)
const allow = (fp) => assert.equal(guardPaths({ filePath: fp }).kind, 'allow', fp)

test('guardPaths denies the secret-bearing pattern classes', () => {
  deny('.env')
  deny('.env.local')
  deny('config/.env.production')
  deny('.envrc')
  deny('secrets/aws.json')
  deny('secret/token.txt')
  deny('certs/server.pem')
  deny('certs/server.key')
  deny('certs/bundle.p12')
  deny('certs/bundle.pfx')
  deny('certs/store.jks')
  deny('certs/store.keystore')
  deny('home/id_rsa')
  deny('home/id_ed25519.pub')
  deny('.netrc')
  deny('.aws/credentials')
  deny('.aws')
  deny('docker/config.json')
  deny('C:/Users/x/project/.env')
  deny('C:\\Users\\x\\project\\.env')
})

test('guardPaths near-misses that must NOT deny (false-positive check)', () => {
  allow('.env.example')
  allow('.env.sample')
  allow('.env.template')
  allow('config/.env.example')
  allow('ENV.md')
  allow('.environment')
  allow('environment/config.md')
  allow('docs/app.pem.bak')
  allow('keystore')            // no dot: the original pattern requires the suffix
  allow('src/keystore.ts')
  allow('id_rsa_notes.md')     // the `($|\.)` boundary
  allow('android/aws/config.json') // `docker/config.json` only
  allow('docker/config.yaml')
  allow('src/env.js')
  allow('README.md')
  allow('')
  // ...and the other direction of the same near-miss: a dotfile NAMED `.env.md` is
  // an env file wherever it sits — the ORIGINAL denies this too (verified by
  // running the original guard-paths.mjs with this exact input).
  deny('environment/.env.md')
})

test('guardPaths de-duplicates nothing but respects table order (first match wins)', () => {
  // `.env` matches both the env pattern and (for `.env.key`) the key pattern;
  // the reason must be the FIRST pattern, as in the original.
  assert.match(guardPaths({ filePath: '.env.key' }).reason, /environment\/secret file/)
})

test('guardTestsPostWrite warns on a locked test file, and distinguishes the override', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { tddLock: true, tddLockPaths: ['src/a.test.js'] } })
  const warn = guardTestsPostWrite({ filePath: 'src/a.test.js', root })
  assert.equal(warn.kind, 'warn')
  assert.match(warn.message, /TDD-lock warning/)
  assert.match(warn.message, /tests are contracts/i)

  intent(root, 'demo', { stateOverrides: { tddLock: true, tddLockPaths: [], tddLockOverride: { at: '2026-10-20', reason: 'contract bug' } } })
  const override = guardTestsPostWrite({ filePath: 'src/b.spec.ts', root })
  assert.equal(override.kind, 'warn')
  assert.match(override.message, /TDD-lock override/)
  assert.match(override.message, /重新上锁/)
})

test('guardTestsPostWrite stays silent when it should (near-miss check)', (t) => {
  const root = tmpRoot(t)
  intent(root, 'demo', { stateOverrides: { tddLock: false } })
  assert.deepEqual(guardTestsPostWrite({ filePath: 'src/a.test.js', root }), { kind: 'allow' })
  intent(root, 'demo', { stateOverrides: { tddLock: true, tddLockPaths: [] } })
  assert.deepEqual(guardTestsPostWrite({ filePath: 'src/app.js', root }), { kind: 'allow' }, 'a non-test file is not a contract hit')
  assert.deepEqual(guardTestsPostWrite({ filePath: 'src/a.test.js', root, config: { tddLock: false } }), { kind: 'allow' }, 'flag off')
  assert.equal(guardTestsPostWrite({ filePath: 'src/a.test.js', root: tmpRoot(t) }).kind, 'allow', 'no intent at all')
})
