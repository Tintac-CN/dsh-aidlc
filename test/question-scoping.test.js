/**
 * Session scoping of the question seam.
 *
 * This is the regression test for a real user report: "some questions cannot be
 * answered and the turn ends early."
 *
 * The plugin registers `user-questions/request` at the ROOT scope, so the
 * listener sees the question waterfall for EVERY session in the process. Before
 * this was scoped, triage would answer a `generic.question` with a model even in
 * an ordinary coding session that never asked for AI-DLC — the human never saw
 * the question, and their turn moved on without the answer they needed.
 *
 * The contract now:
 *   - session NOT in AIDLC mode, `interceptAllSessions` off (the default)
 *     → the listener delegates to `next()` immediately and never consults the
 *       decision transport;
 *   - `interceptAllSessions: true`
 *     → the decision layer may answer, which is the opt-in an operator makes
 *       explicitly.
 *
 * The mock context deliberately has no `sessionProjections`, which is what an
 * out-of-mode session looks like: `isAidlcMode()` returns false rather than
 * throwing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Boot the plugin against a minimal mock and return the question listener. */
async function boot (t, config) {
  let mod
  try {
    mod = await import('../lib/index.js')
  } catch (error) {
    t.skip(`harness packages unavailable (${error.message.split('\n')[0]})`)
    return null
  }
  const listeners = new Map()
  const ctx = {
    logger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
    on: (event, handler) => { listeners.set(event, handler); return () => {} },
    effect: () => ({ dispose: async () => {} }),
    get: () => undefined,
    commands: { register: () => () => {} },
    tools: { register: () => () => {}, get: () => undefined },
  }
  mod.apply(ctx, config)
  return listeners.get('user-questions/request')
}

const QUESTION = {
  questions: [{ id: 'q1', question: 'Which target should the export write to?', options: [{ label: 'A' }, { label: 'B' }] }],
}

test('outside AIDLC mode the answerer delegates and never consults the model', async (t) => {
  let transportCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    transportCalls += 1
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"choice":"A","confidence":0.99,"risk":"low","reason":"x"}' } }] }), text: async () => '' }
  }
  try {
    const answerer = await boot(t, {
      decision: { model: { protocol: 'chat', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k' } },
    })
    if (answerer === null) return
    assert.equal(typeof answerer, 'function', 'the plugin registers the question answerer')

    let delegated = 0
    const humanAnswer = { answers: [{ id: 'q1', selected: ['A'] }] }
    const result = await answerer(QUESTION, async () => {
      delegated += 1
      return humanAnswer
    })

    assert.equal(delegated, 1, 'the human answerer must be consulted')
    assert.deepEqual(result, humanAnswer, 'and its answer returned unchanged')
    assert.equal(transportCalls, 0, 'the decision transport must NOT be consulted outside AIDLC mode')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the opt-in lets the decision layer answer, so the scoping is a gate and not a removal', async (t) => {
  let transportCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    transportCalls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"choice":"A","confidence":0.99,"risk":"low","reason":"obvious"}' } }] }),
      text: async () => '',
    }
  }
  try {
    const answerer = await boot(t, {
      decision: {
        interceptAllSessions: true,
        classes: { 'generic.question': 'triage' },
        confidenceThreshold: 0.6,
        model: { protocol: 'chat', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', timeoutMs: 5000 },
      },
    })
    if (answerer === null) return

    let delegated = 0
    const result = await answerer(QUESTION, async () => {
      delegated += 1
      return { answers: [{ id: 'q1', selected: ['B'] }] }
    })

    // Either the model claimed it above the bar, or it escalated — both are
    // acceptable outcomes of the gate; what must NOT happen is the transport
    // being skipped entirely now that the operator opted in.
    assert.ok(transportCalls > 0, 'with the opt-in the transport is consulted')
    if (delegated === 0) {
      assert.ok(result !== undefined && result !== null, 'a claimed question returns an answer')
      assert.equal(result.answers[0].selected[0], 'A', 'and it is the model choice')
    }
  } finally {
    globalThis.fetch = realFetch
  }
})
