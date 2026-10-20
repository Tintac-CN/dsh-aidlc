/**
 * `lib/decision/systemone.js` + `lib/decision/reviewer.js` + `lib/decision/audit.js`.
 *
 * Every transport is attacked with an INJECTED fetch / stream: HTTP errors,
 * non-JSON bodies, empty content, prose-wrapped JSON, truncated JSON, truncated
 * streams, a missing key, a disguised-remote loopback claim. Nothing here opens
 * a socket; a test that reaches the network would hang and fail.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  DEFAULT_SYSTEMONE_BASE_URL,
  callSystemone,
  isLoopbackEndpoint,
  normalizeAnswers,
  resolveApiKey,
} from '../lib/decision/systemone.js'
import {
  callChatReviewer,
  callSessionModelReviewer,
  collectTextFromChunks,
  createConsultant,
  extractJsonObject,
  normalizeDecision,
  parseDecisionJson,
} from '../lib/decision/reviewer.js'
import { DEFAULT_AUDIT_PATH, createAuditSink, formatAuditLine, parseAuditLines, readAuditFile, resolveAuditPath, sanitizeEntry } from '../lib/decision/audit.js'
import { tmpRoot } from './helpers.mjs'

/** A fetch double: `{ok, status, json, text}` or a thrown error. */
const fetchDouble = (response) => async () => {
  if (response instanceof Error) throw response
  return {
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => {
      if (response.jsonError) throw new Error('not json')
      return response.json
    },
    text: async () => response.text ?? '',
  }
}

const goodSystemone = {
  json: {
    model: 'Kev-4b',
    answers: { decision: { choice: 'Approve', confidence: 0.82, probabilities: { Approve: 0.91, Reject: 0.09 } }, risk: { choice: 'low' } },
  },
}

/* ─────────────────────────────── systemone ────────────────────────────────── */

test('isLoopbackEndpoint handles localhost, v4 loopback and the credential disguise', () => {
  assert.equal(isLoopbackEndpoint('http://localhost:1234/v1'), true)
  assert.equal(isLoopbackEndpoint('http://127.0.0.1:8080'), true)
  assert.equal(isLoopbackEndpoint('http://127.5.5.5:1'), true)
  assert.equal(isLoopbackEndpoint('http://[::1]:9/'), true)
  assert.equal(isLoopbackEndpoint('https://api.siliconflow.cn/v1'), false)
  assert.equal(isLoopbackEndpoint('http://127.0.0.1@evil.example/v1'), false, 'the authority trick must not read as loopback')
  assert.equal(isLoopbackEndpoint('not a url'), false)
  assert.equal(isLoopbackEndpoint(''), false)
})

test('resolveApiKey precedence: literal, env, key file; comments and blanks skipped', async () => {
  assert.equal(await resolveApiKey({ apiKey: ' sk-lit ', apiKeyEnv: 'X', env: { X: 'sk-env' } }), 'sk-lit')
  assert.equal(await resolveApiKey({ apiKeyEnv: 'X', env: { X: ' sk-env ' } }), 'sk-env')
  assert.equal(await resolveApiKey({ apiKeyEnv: 'MISSING', env: {} }), null)
  const read = async () => '# comment\n\nKEY=sk-file\n'
  assert.equal(await resolveApiKey({ apiKeyFile: 'k.env', readFile: read }), 'sk-file')
  assert.equal(await resolveApiKey({ apiKeyFile: 'k.env', readFile: async () => { throw new Error('ENOENT') } }), null, 'an unreadable key file is not a key')
  assert.equal(await resolveApiKey({ apiKeyFile: 'k.env', readFile: async () => 'nonsense\n' }), null)
  assert.equal(await resolveApiKey({}), null)
})

test('callSystemone sends the documented wire shape and normalises the answers', async () => {
  let seen
  const result = await callSystemone({
    baseURL: 'https://api.example.com/v1/',
    model: 'Kev-4b',
    apiKey: 'sk-x',
    state: { policy: 'P', request: { id: 'q1' } },
    questions: { decision: { type: 'choice', instructions: 'i', criteria: { Approve: 'a' } } },
    maxLen: 1024,
    timeoutMs: 0,
    fetch: async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, json: async () => goodSystemone.json, text: async () => '' }
    },
  })
  assert.equal(seen.url, 'https://api.example.com/v1/systemone')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers.authorization, 'Bearer sk-x')
  const body = JSON.parse(seen.init.body)
  assert.deepEqual(Object.keys(body).sort(), ['max_len', 'model', 'questions', 'state'])
  assert.equal(body.max_len, 1024)
  assert.equal(body.state.policy, 'P')
  assert.equal(result.servedBy, 'Kev-4b')
  assert.equal(result.answers.decision.choice, 'Approve')
})

test('callSystemone fails closed on every transport failure', async () => {
  const base = {
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    apiKey: 'k',
    state: {},
    questions: { decision: { type: 'choice', instructions: '', criteria: {} } },
    timeoutMs: 0,
  }
  await assert.rejects(() => callSystemone({ ...base, fetch: fetchDouble(new Error('ECONNREFUSED')) }), /request failed/)
  await assert.rejects(() => callSystemone({ ...base, fetch: fetchDouble({ ok: false, status: 500, text: 'boom' }) }), /HTTP 500/)
  await assert.rejects(() => callSystemone({ ...base, fetch: fetchDouble({ jsonError: true }) }), /non-JSON/)
  await assert.rejects(() => callSystemone({ ...base, fetch: fetchDouble({ json: null }) }), /non-object body/)
  await assert.rejects(() => callSystemone({ ...base, fetch: fetchDouble({ json: {} }) }), /no answers map/)
  await assert.rejects(() => callSystemone({ ...base, fetch: fetchDouble({ json: { answers: {} } }) }), /no usable answers/)
  await assert.rejects(() => callSystemone({ ...base, questions: {}, fetch: fetchDouble(goodSystemone) }), /non-empty map/)
  await assert.rejects(() => callSystemone({ ...base, state: 'x', fetch: fetchDouble(goodSystemone) }), /state must be an object/)
  await assert.rejects(() => callSystemone({ ...base, apiKey: '', fetch: fetchDouble(goodSystemone) }), /no API key/)
})

test('callSystemone tolerates a keyless LOOPBACK endpoint only', async () => {
  const questions = { decision: { type: 'choice', instructions: '', criteria: {} } }
  const result = await callSystemone({ baseURL: 'http://127.0.0.1:9000', apiKey: '', state: {}, questions, timeoutMs: 0, fetch: fetchDouble(goodSystemone) })
  assert.equal(result.answers.decision.choice, 'Approve')
  assert.equal(DEFAULT_SYSTEMONE_BASE_URL, 'https://api.siliconflow.cn/v1')
})

test('normalizeAnswers drops unusable entries and keeps finite probabilities', () => {
  const out = normalizeAnswers({
    answers: {
      a: { choice: 'Approve', confidence: 0.5, probabilities: { Approve: 0.6, Bad: 'x' } },
      b: { choice: '   ' },
      c: { confidence: 0.9 },
      d: 'nope',
      e: { choice: 'Reject', confidence: Number.NaN },
    },
  })
  assert.deepEqual(Object.keys(out), ['a', 'e'])
  assert.deepEqual(out.a.probabilities, { Approve: 0.6 })
  assert.equal('confidence' in out.e, false)
  assert.throws(() => normalizeAnswers({}), /no answers map/)
})

/* ──────────────────────────────── reviewer ────────────────────────────────── */

test('extractJsonObject: fences, prose, and the truncated-object failure', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('Sure! Here you go:\n{"a":1}\nHope that helps'), { a: 1 })
  assert.throws(() => extractJsonObject(''), /empty/)
  assert.throws(() => extractJsonObject('no object here'), /did not contain a JSON object/)
  assert.throws(() => extractJsonObject('{"a":'), /did not contain a JSON object/, 'a truncated object is rejected either way')
  assert.throws(() => extractJsonObject('[1,2]'), /did not contain a JSON object|\{\}/)
})

test('normalizeDecision/parseDecisionJson refuse anything unusable', () => {
  assert.throws(() => normalizeDecision(null), /not an object/)
  assert.throws(() => normalizeDecision({}), /no usable "choice"/)
  assert.throws(() => normalizeDecision({ choice: 'A', confidence: 2 }), /invalid "confidence"/)
  assert.throws(() => normalizeDecision({ choice: 'A', risk: 'spicy' }), /invalid "risk"/)
  const ok = parseDecisionJson('{"choice":"A","confidence":0.5,"risk":"HIGH","reason":"r","probabilities":{"A":0.7}}')
  assert.equal(ok.risk, 'high')
  assert.deepEqual(ok.probabilities, { A: 0.7 })
  assert.equal(ok.lowConfidence, false)
  assert.equal(parseDecisionJson('{"choice":"A","low_confidence":true}').lowConfidence, true)
  // D3 CLOSED: the camelCase spelling survives too, and so does a second pass
  assert.equal(parseDecisionJson('{"choice":"A","lowConfidence":true}').lowConfidence, true)
  assert.equal(normalizeDecision(parseDecisionJson('{"choice":"A","low_confidence":true}')).lowConfidence, true)
  assert.equal(normalizeDecision({ choice: 'A', lowConfidence: true }).lowConfidence, true)
  assert.equal(parseDecisionJson('{"choice":"A","low_confidence":"yes"}').lowConfidence, false, 'only an explicit boolean counts')
  assert.equal(parseDecisionJson('{"choice":"A"}').risk, 'unknown')
})

test('callChatReviewer fails closed on HTTP errors, empty content and non-JSON bodies', async () => {
  const base = { baseURL: 'https://api.example.com/v1', model: 'm', apiKey: 'k', system: 's', user: 'u', timeoutMs: 0 }
  await assert.rejects(() => callChatReviewer({ ...base, fetch: fetchDouble({ ok: false, status: 429, text: 'slow down' }) }), /HTTP 429/)
  await assert.rejects(() => callChatReviewer({ ...base, fetch: fetchDouble({ jsonError: true }) }), /non-JSON body/)
  await assert.rejects(() => callChatReviewer({ ...base, fetch: fetchDouble({ json: { choices: [] } }) }), /empty content/)
  await assert.rejects(() => callChatReviewer({ ...base, fetch: fetchDouble({ json: { choices: [{ message: { content: '   ' } }] } }) }), /empty content/)
  await assert.rejects(() => callChatReviewer({ ...base, baseURL: '', fetch: fetchDouble({}) }), /baseURL is required/)
  await assert.rejects(() => callChatReviewer({ ...base, apiKey: '', fetch: fetchDouble({}) }), /no API key/)
  await assert.rejects(() => callChatReviewer({ ...base, fetch: undefined, apiKey: 'k' }), /request failed|fetch implementation/)
})

test('callChatReviewer returns final text only, never reasoning_content', async () => {
  const text = await callChatReviewer({
    baseURL: 'https://api.example.com/v1',
    apiKey: 'k',
    system: 's',
    user: 'u',
    timeoutMs: 0,
    fetch: fetchDouble({ json: { choices: [{ message: { content: '{"choice":"A"}', reasoning_content: '{"choice":"EVIL"}' } }] } }),
  })
  assert.equal(text, '{"choice":"A"}')
  const onlyReasoning = fetchDouble({ json: { choices: [{ message: { reasoning_content: '{"choice":"EVIL"}' } }] } })
  await assert.rejects(() => callChatReviewer({ baseURL: 'https://x/v1', apiKey: 'k', timeoutMs: 0, fetch: onlyReasoning }), /empty content/)
})

test('createConsultant(chat) retries once on unparseable output and still fails closed', async () => {
  let calls = 0
  const consultant = createConsultant({
    protocol: 'chat',
    config: { baseURL: 'https://api.example.com/v1', apiKey: 'k', timeoutMs: 0 },
    fetch: async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: calls === 1 ? 'not json' : '{"choice":"Approve","confidence":0.9,"risk":"low"}' } }] }),
        text: async () => '',
      }
    },
  })
  const verdict = await consultant({ system: 's', user: 'u' }, {})
  assert.equal(calls, 2, 'one corrective retry')
  assert.equal(verdict.choice, 'Approve')
  assert.equal(verdict.backend, 'chat:')
  // NOTE: a verdict that omits `risk` is refused by this transport — see
  // test/known-defects.test.js ("createConsultant double-normalises").

  const alwaysBad = createConsultant({
    protocol: 'chat',
    config: { baseURL: 'https://api.example.com/v1', apiKey: 'k', timeoutMs: 0 },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'nope' } }] }), text: async () => '' }),
  })
  await assert.rejects(() => alwaysBad({ system: 's', user: 'u' }, {}))
})

test('the transport-side self-distrust marker uses the same quantity as the arbiter', async () => {
  const consultant = createConsultant({
    protocol: 'chat',
    config: { baseURL: 'https://api.example.com/v1', apiKey: 'k', timeoutMs: 0 },
    confidenceThreshold: 0.6,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"choice":"A","confidence":0.9,"risk":"low","probabilities":{"A":0.55,"B":0.45}}' } }] }), text: async () => '' }),
  })
  const verdict = await consultant({ system: 's', user: 'u' }, {})
  assert.equal(verdict.lowConfidence, true, 'p_max 0.55 is below the 0.6 floor even though confidence says 0.9')
  assert.equal(verdict.choice, 'A', 'the marker never rewrites the choice')
})

test('collectTextFromChunks accumulates deltas, ignores reasoning and does not double count', async () => {
  async function* chunks() {
    yield { type: 'text-delta', index: 0, text: '{"choice"' }
    yield { type: 'reasoning-delta', index: 1, text: 'SECRET' }
    yield { type: 'text-delta', index: 0, text: ':"A"}' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"choice":"A"}' } }
    yield { type: 'block-end', index: 2, block: { type: 'text', text: '{no deltas}' } }
    yield { type: 'reasoning', block: { type: 'reasoning', text: 'SECRET' } }
  }
  assert.equal(await collectTextFromChunks(chunks()), '{"choice":"A"}{no deltas}')
})

test('callSessionModelReviewer requires provider/model and fails closed', async () => {
  await assert.rejects(() => callSessionModelReviewer({ streamFn: undefined }), /no llm stream function/)
  await assert.rejects(() => callSessionModelReviewer({ streamFn: async function* () {}, provider: 'p' }), /no provider\/model/)
  await assert.rejects(
    () => callSessionModelReviewer({ streamFn: async function* () {}, provider: 'p', model: 'm' }),
    /empty content/,
  )
  await assert.rejects(
    () => callSessionModelReviewer({ streamFn: () => null, provider: 'p', model: 'm' }),
    /not async-iterable/,
  )
  const verdict = await callSessionModelReviewer({
    streamFn: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"choice":"Approve","confidence":0.8,"risk":"low"}' }
    },
    provider: 'deepseek-official',
    model: 'deepseek-v4',
  })
  assert.equal(verdict.choice, 'Approve')
  assert.equal(verdict.backend, 'session:deepseek-official/deepseek-v4')
})

test('createConsultant refuses an unknown protocol', () => {
  assert.throws(() => createConsultant({ protocol: 'carrier-pigeon' }), /unknown protocol/)
})

/* ──────────────────────────────── audit ───────────────────────────────────── */

test('sanitizeEntry drops secret-shaped keys and truncates long strings', () => {
  const clean = sanitizeEntry({
    apiKey: 'sk-secret',
    authorization: 'Bearer x',
    cookie: 'a=b',
    session_id: 'abc',
    token: 't',
    password: 'p',
    reason: 'x'.repeat(2500),
    nested: { secret: 'gone', keep: 1 },
    arr: Array.from({ length: 60 }, (_, i) => i),
    nan: Number.NaN,
    big: 10n,
    fn: () => {},
  })
  for (const key of ['apiKey', 'authorization', 'cookie', 'session_id', 'token', 'password']) assert.equal(key in clean, false, key)
  assert.equal(clean.nested.secret, undefined)
  assert.equal(clean.nested.keep, 1)
  assert.match(clean.reason, /…\[\+500\]$/)
  assert.equal(clean.arr.length, 50)
  assert.equal(clean.nan, null)
  assert.equal(clean.big, '10')
  assert.equal('fn' in clean, false)
})

test('formatAuditLine always yields exactly one line, even for hostile input', () => {
  assert.equal(formatAuditLine({ a: 1 }).split('\n').length, 2, 'one JSON line plus the terminator')
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  const line = formatAuditLine(cyclic)
  assert.equal(line.endsWith('\n'), true)
  assert.equal(JSON.parse(line).a, 1)
  assert.equal(formatAuditLine(undefined).endsWith('\n'), true)
})

test('parseAuditLines counts malformed lines instead of throwing', () => {
  const parsed = parseAuditLines('{"a":1}\n\nnot json\n[1,2]\n{"b":2}\n')
  assert.equal(parsed.total, 4)
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.malformed, 2)
})

test('resolveAuditPath resolves relative paths against the root and rejects an empty path', () => {
  assert.equal(resolveAuditPath(''), null, 'an empty path resolves to null, so record() reports no-path')
  assert.equal(resolveAuditPath('   '), null)
  assert.equal(resolveAuditPath().endsWith('decision-audit.jsonl'), true, 'no argument means the documented default')
  assert.equal(resolveAuditPath('docs/aidlc/decision-audit.jsonl', '/root').replace(/\\/g, '/').endsWith('root/docs/aidlc/decision-audit.jsonl'), true)
  assert.equal(resolveAuditPath('C:/abs/audit.jsonl', '/root').replace(/\\/g, '/'), 'C:/abs/audit.jsonl', 'an absolute path is taken as-is')
  assert.equal(DEFAULT_AUDIT_PATH, 'docs/aidlc/decision-audit.jsonl')
})

test('createAuditSink buffers, reports no-path, and never throws into the decision path', async (t) => {
  const root = tmpRoot(t)
  const written = []
  const sink = createAuditSink({
    path: 'audit.jsonl',
    root,
    fs: {
      appendFile: async (file, line) => {
        written.push({ file, line })
      },
      mkdir: async () => {},
    },
  })
  assert.equal(sink.record({ code: 'x', apiKey: 'sk-secret' }).ok, true)
  assert.equal(sink.record({ code: 'y' }).ok, true)
  await sink.flush()
  assert.equal(written.length, 2)
  assert.equal(written[0].line.includes('sk-secret'), false, 'the file never sees a secret')
  assert.equal(sink.entries().length, 2)

  const broken = createAuditSink({
    path: 'audit.jsonl',
    root,
    fs: {
      appendFile: async () => {
        throw new Error('EACCES')
      },
      mkdir: async () => {},
    },
    onError: () => {
      throw new Error('an observer must never break the sink')
    },
  })
  assert.equal(broken.record({ code: 'x' }).ok, true, 'record() is synchronous and never throws')
  await broken.flush()
  assert.equal(broken.lastError(), 'EACCES')

  const disabled = createAuditSink({ path: 'audit.jsonl', root, enabled: false, fs: { appendFile: async () => {}, mkdir: async () => {} } })
  assert.deepEqual(disabled.record({ code: 'x' }), { ok: true, code: 'disabled' })

  const noPath = createAuditSink({ path: '', root })
  assert.deepEqual(noPath.record({ code: 'x' }), { ok: false, code: 'no-path' })
})

test('readAuditFile degrades to an empty result rather than throwing', async () => {
  assert.deepEqual(await readAuditFile(null, async () => ''), { entries: [], malformed: 0, total: 0 })
  assert.deepEqual(await readAuditFile('x', null), { entries: [], malformed: 0, total: 0 })
  assert.deepEqual(await readAuditFile('x', async () => { throw new Error('ENOENT') }), { entries: [], malformed: 0, total: 0 })
  const parsed = await readAuditFile('x', async () => '{"a":1}\n')
  assert.equal(parsed.entries.length, 1)
})

test('the audit sink writes real files when given one', async (t) => {
  const root = tmpRoot(t)
  const sink = createAuditSink({ path: join('docs', 'aidlc', 'decision-audit.jsonl'), root })
  sink.record({ code: 'substituted', question_id: 'q1' })
  await sink.flush()
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(join(root, 'docs', 'aidlc', 'decision-audit.jsonl'), 'utf8')
  assert.equal(JSON.parse(text).code, 'substituted')
})
