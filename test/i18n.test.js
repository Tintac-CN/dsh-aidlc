/**
 * The message catalogue's own tests.
 *
 * The requirement that matters most: **a missing translation must be a test
 * failure, not a silent blank.** A blocked developer reading an empty deny reason
 * is worse than reading the wrong language, so the two locales are asserted to
 * define exactly the same key set, with the same placeholders, both non-empty.
 *
 * The second requirement: **machine-readable text is never translated.** The
 * receipt lines, class ids, mode ids and paths are asserted byte-identical across
 * locales, because `parseHumanReceipt`/`parseAutoReceipt` would stop recognising a
 * translated receipt and the audit chain would break.
 *
 * @module dsh-aidlc/test/i18n
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_LOCALE, LOCALES, MESSAGES, catalogueSize, format, fromConfig, getLocale, keysOf, normalizeLocale, setLocale, t } from '../lib/i18n.js'

/** Placeholder names used by one template. */
const placeholdersOf = (template) => [...String(template).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort()

test('both locales define exactly the same key set', () => {
  const en = keysOf('en')
  const zh = keysOf('zh-CN')
  assert.deepEqual(zh, en, 'a key present in one locale and not the other is a missing translation')
  assert.ok(en.length > 0)
  // And no locale is silently short: every catalogue entry carries both.
  for (const [key, entry] of Object.entries(MESSAGES)) {
    assert.equal(typeof entry.en, 'string', `${key} is missing en`)
    assert.equal(typeof entry['zh-CN'], 'string', `${key} is missing zh-CN`)
    assert.notEqual(entry.en.trim(), '', `${key} has an empty en message`)
    assert.notEqual(entry['zh-CN'].trim(), '', `${key} has an empty zh-CN message`)
  }
})

test('no message is a copy of the other locale (a real translation, not a placeholder)', () => {
  // `common.listSeparator` is punctuation and legitimately differs only slightly;
  // everything else must differ, because an untranslated string that merely
  // LOOKS translated is the inconsistency this whole exercise is about.
  const identical = Object.entries(MESSAGES)
    .filter(([key, entry]) => key !== 'common.listSeparator' && entry.en === entry['zh-CN'])
    .map(([key]) => key)
  assert.deepEqual(identical, [], 'these keys have identical text in both locales')
})

test('the two locales use the same placeholders', () => {
  for (const [key, entry] of Object.entries(MESSAGES)) {
    assert.deepEqual(placeholdersOf(entry['zh-CN']), placeholdersOf(entry.en), `${key}: placeholder mismatch between locales`)
  }
})

test('every message renders in both locales, with every placeholder filled', () => {
  for (const key of keysOf('en')) {
    const names = placeholdersOf(MESSAGES[key].en)
    const params = Object.fromEntries(names.map((n) => [n, `«${n}»`]))
    for (const locale of LOCALES) {
      const rendered = t(key, params, locale)
      assert.equal(typeof rendered, 'string')
      assert.notEqual(rendered.trim(), '', `${key} rendered empty in ${locale}`)
      assert.doesNotMatch(rendered, /\{[a-zA-Z0-9_]+\}/, `${key} left a placeholder unfilled in ${locale}`)
    }
  }
})

test('an unknown key falls back to the key itself, not to a blank', () => {
  assert.equal(t('no.such.key'), 'no.such.key')
  assert.equal(t('no.such.key', {}, 'zh-CN'), 'no.such.key')
  // A key that exists but is asked for in a nonsense locale still resolves.
  assert.notEqual(t('guard.receipt.missing', { gate: 'gate1' }, 'klingon').trim(), '')
})

test('format leaves an unknown placeholder visible so a bug reads as a bug', () => {
  assert.equal(format('a {x} b', { x: 1 }), 'a 1 b')
  assert.equal(format('a {missing} b'), 'a {missing} b')
  assert.equal(format('{a}-{b}', { a: null, b: undefined }), '-')
})

test('normalizeLocale is tolerant and never throws', () => {
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('EN'), 'en')
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN')
  assert.equal(normalizeLocale('zh'), 'zh-CN')
  assert.equal(normalizeLocale('zh-cn'), 'zh-CN')
  assert.equal(normalizeLocale('zh-Hans'), 'zh-CN')
  // Unknown or absent values fall back to the default rather than throwing: a
  // typo in a config key must not stop the plugin from loading.
  for (const value of [undefined, null, '', 'fr', 'de-DE', 42, {}, []]) {
    assert.equal(normalizeLocale(value), DEFAULT_LOCALE)
  }
})

test('the default locale is en, and it is a supported locale', () => {
  assert.equal(DEFAULT_LOCALE, 'en')
  assert.ok(LOCALES.includes(DEFAULT_LOCALE))
  assert.deepEqual([...LOCALES], ['en', 'zh-CN'])
})

test('setLocale changes the active locale and returns what took effect', () => {
  const before = getLocale()
  try {
    assert.equal(setLocale('zh-CN'), 'zh-CN')
    assert.equal(getLocale(), 'zh-CN')
    assert.match(t('guard.ledger.notAppendOnly'), /只追加/)
    assert.equal(setLocale('nonsense'), DEFAULT_LOCALE)
    assert.equal(getLocale(), DEFAULT_LOCALE)
    assert.match(t('guard.ledger.notAppendOnly'), /append-only/)
  } finally {
    setLocale(before)
  }
})

test('fromConfig reads the locale off a resolved config, and survives a missing one', () => {
  const zh = fromConfig({ locale: 'zh-CN' }, 'guard.ledger.notAppendOnly')
  assert.match(zh, /只追加/)
  const en = fromConfig({ locale: 'en' }, 'guard.ledger.notAppendOnly')
  assert.match(en, /append-only/)
  // No config at all must still produce a message, not a throw.
  for (const config of [undefined, null, {}, { locale: undefined }, { locale: 'xx' }]) {
    assert.notEqual(fromConfig(config, 'guard.ledger.notAppendOnly').trim(), '')
  }
})

test('MACHINE TEXT IS NEVER TRANSLATED: receipts, classes, modes and paths', () => {
  // The receipt grammar is parsed by ledger.js. A translated receipt would stop
  // parsing and break the audit chain, so these literals appear verbatim in both
  // locales wherever a message mentions them.
  const machineLiterals = ['GATE-APPROVED', 'GATE-REJECTED', 'AUTO-APPROVED', 'AUTO-REJECTED', 'decisions.md', 'state.json', 'gate.approval', 'triage', '/aidlc-gate', '/aidlc-resume', '/aidlc-lock-tests', '/aidlc-unlock-tests']
  const messages = ['guard.receipt.missing', 'guard.receipt.rejected', 'guard.receipt.autoPresent', 'guard.receipt.other']
  const params = { gate: 'gate1', when: ' (2026-10-20)', hadAuto: '', count: 1, list: 'AUTO-APPROVED 2026-10-20', modeText: 'x', error: 'EACCES', slug: 'demo', path: '/x/plan.md', state: 'pending', what: 'state.json', checked: 'x', at: '2026-10-20', by: '', conf: '', reason: 'r', why: 'a secret file' }
  for (const key of keysOf('en')) {
    if (!messages.includes(key)) continue
    for (const locale of LOCALES) {
      const text = t(key, params, locale)
      for (const literal of machineLiterals) {
        if (!MESSAGES[key].en.includes(literal)) continue
        assert.ok(text.includes(literal), `${key} (${locale}) dropped or translated the machine literal ${literal}`)
      }
    }
  }
  // And the catalogue must never contain a translated receipt: the number of
  // ASCII receipt literals is identical in both locales, so a translator cannot
  // have swapped one for prose.
  const receiptRe = /\b(GATE|AUTO)-(APPROVED|REJECTED|APPROVE|REJECT)\b/g
  for (const [key, entry] of Object.entries(MESSAGES)) {
    const enCount = (entry.en.match(receiptRe) ?? []).length
    const zhCount = (entry['zh-CN'].match(receiptRe) ?? []).length
    assert.equal(zhCount, enCount, `${key}: receipt-literal count differs between locales (${enCount} vs ${zhCount})`)
  }
  // An English message has no CJK in it, except where it legitimately quotes a
  // Chinese artifact header. This catches a half-translated paste.
  for (const [key, entry] of Object.entries(MESSAGES)) {
    const cjk = entry.en.match(/[\u4e00-\u9fff]+/g) ?? []
    const allowed = ['验收标准', '映射', '测试点清单'] // literal artifact headings the parsers MATCH on — these must never be translated
    const unexpected = cjk.filter((run) => !allowed.some((a) => run.includes(a)))
    assert.deepEqual(unexpected, [], `${key}: the EN message contains CJK ${JSON.stringify(unexpected)}`)
  }
})

test('the catalogue is not trivially small (a size guard against accidental truncation)', () => {
  assert.ok(catalogueSize() >= 20, `only ${catalogueSize()} keys catalogued`)
  assert.equal(keysOf('en').length, catalogueSize())
})

/* ─────────────────── the guard reasons keep their STRUCTURE in both locales ─── */

test('a guard denial says what rule fired, what state caused it, and the remedy — in BOTH locales', async () => {
  const { guardWrite } = await import('../lib/aidlc/guards.js')
  const { tmpRoot, intent } = await import('./helpers.mjs')

  for (const locale of LOCALES) {
    const config = { guards: { enabled: true, constructionGate: true, tddLock: true, overwriteIntegrity: true, acCoverage: true, protectedPaths: true }, locale }
    const t0 = { after: () => {} }
    const root = tmpRoot({ after: () => {} })

    // Rule 1: a Construction artifact before gate1 is approved.
    intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending' } } })
    const denied = guardWrite({ filePath: 'docs/aidlc/demo/plan.md', content: '# plan\n', root, config })
    assert.equal(denied.kind, 'deny', `${locale}: must deny`)

    // STRUCTURE, not wording: the three things a developer needs must all be present.
    assert.match(denied.reason, /plan\.md/, `${locale}: names the artifact (what caused it)`)
    assert.match(denied.reason, /pending|inception/, `${locale}: names the state`)
    assert.match(denied.reason, /\/aidlc-gate/, `${locale}: names the remedy command`)
    assert.match(denied.reason, /Gate#1/, `${locale}: names the rule`)
    // The two locales render DIFFERENT prose — i.e. the locale really was applied.
    const hasCjk = /[\u4e00-\u9fff]/.test(denied.reason)
    assert.equal(hasCjk, locale === 'zh-CN', `${locale}: wrong language rendered`)
  }
})

test('the default locale leaves behaviour identical to before the catalogue existed', async () => {
  const { guardWrite } = await import('../lib/aidlc/guards.js')
  const { tmpRoot, intent } = await import('./helpers.mjs')
  // `locale` absent entirely — every existing caller's shape — must still resolve.
  const config = { guards: { enabled: true, constructionGate: true } }
  const root = tmpRoot({ after: () => {} })
  intent(root, 'demo', { stateOverrides: { phase: 'inception', gates: { gate1: 'pending' } } })
  const denied = guardWrite({ filePath: 'docs/aidlc/demo/plan.md', content: '# plan\n', root, config })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /Gate#1 has not passed/, 'with no locale configured the message is English')
})

test('the injected session context switches language, and keeps every machine literal', async () => {
  const { sessionStartContext } = await import('../lib/surface/context.js')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = mkdtempSync(join(tmpdir(), 'aidlc-i18n-context-'))
  try {
    const dir = join(root, 'docs', 'aidlc', 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ slug: 'demo', phase: 'inception', route: 'classic', gates: { gate1: 'pending' }, updatedAt: '2026-10-20T00:00:00Z' }))
    writeFileSync(join(dir, 'decisions.md'), '# Decisions\nGATE-APPROVED gate1 2026-10-19\n')
    const decision = { levelFloors: { C1_TRIVIAL: 0.6, C2_SIMPLE: 0.85, C3_COMPLEX: 0.95 }, confidenceThreshold: 0.6 }

    const en = sessionStartContext({ root, config: { decision } })
    const zh = sessionStartContext({ root, config: { decision, locale: 'zh-CN' } })
    assert.equal(/[\u4e00-\u9fff]/.test(en), false, 'the EN context must contain no CJK')
    assert.equal(/[\u4e00-\u9fff]/.test(zh), true, 'the zh-CN context must actually be Chinese')
    assert.notEqual(en, zh, 'the locale must change the injected text')

    // Machine text survives identically in BOTH: the ledger line is parsed, the
    // ids are matched, and the band numbers are calibration data.
    const literals = ['GATE-APPROVED gate1 2026-10-19', 'AUTO-APPROVED', 'AUTO-REJECTED', 'gate.approval', 'advisory', 'triage', 'test.unlock', 'untrusted.authorization', 'decisions.md', '0.6', '0.85', '0.95']
    for (const literal of literals) {
      assert.ok(en.includes(literal), `EN context dropped the machine literal ${literal}`)
      assert.ok(zh.includes(literal), `zh-CN context dropped the machine literal ${literal}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
