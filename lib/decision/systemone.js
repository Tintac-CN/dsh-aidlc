/**
 * System One / Jev HTTP transport: ONE decision call answers typed choice
 * questions against one state.
 *
 * Wire format confirmed against a shipping DSH plugin
 * (`xlennart/dsh-auto-review-jev`, `src/reviewer.ts` — `callSystemoneReviewer`):
 * `POST {base}/systemone` with `{model, state:{policy, request}, questions,
 * max_len?}`, a Bearer key, and a response of
 * `{model, answers:{<qid>:{choice, probabilities, confidence}}}`.
 *
 * Every failure mode throws, and the arbiter turns a throw into a fail-closed
 * `source:'none'`. This module never decides anything itself.
 *
 * @module dsh-aidlc/decision/systemone
 */
import { readFile } from 'node:fs/promises'

/** Default endpoint: SiliconFlow's System One API (Alpha). TypeSafe Jev speaks the same shape. */
export const DEFAULT_SYSTEMONE_BASE_URL = 'https://api.siliconflow.cn/v1'

/** Provisional default model; a real-machine smoke test decides the right pick. */
export const DEFAULT_SYSTEMONE_MODEL = 'Kev-4b'

/** Default per-call deadline, matching the reference plugin. */
export const DEFAULT_SYSTEMONE_TIMEOUT_MS = 24_000

const RISK_VALUES = new Set(['low', 'medium', 'high', 'critical'])

/**
 * True when `baseURL` addresses this machine.
 *
 * Parsed as a URL rather than string-matched, because credentials in the
 * authority disguise a remote host: `http://127.0.0.1@evil.example/v1` parses
 * to host `evil.example`. Copied from the reference implementation.
 *
 * @param {unknown} baseURL
 * @returns {boolean}
 */
export function isLoopbackEndpoint(baseURL) {
  const raw = String(baseURL ?? '').trim()
  if (!raw) return false
  let host
  try {
    host = new URL(raw).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host === 'localhost' || host === '::1') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return v4 !== null && Number(v4[1]) === 127
}

/**
 * Resolve an API key from the three supported sources, in precedence order.
 *
 * `env` and `readFile` are injectable so this is unit-testable without a
 * process environment or a filesystem. The one line format accepted from a key
 * file is `NAME=value` (comments and blank lines skipped) — the same shape the
 * reference plugin reads.
 *
 * @param {{apiKey?:string, apiKeyEnv?:string, apiKeyFile?:string, env?:Record<string,string|undefined>, readFile?:(path:string)=>Promise<string>}} [sources]
 * @returns {Promise<string|null>}
 */
export async function resolveApiKey(sources = {}) {
  const { apiKey, apiKeyEnv, apiKeyFile, env, readFile: read } = sources
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
  if (typeof apiKeyEnv === 'string' && apiKeyEnv.trim()) {
    const table = env ?? (typeof process !== 'undefined' ? process.env : {})
    const value = table?.[apiKeyEnv.trim()]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  if (typeof apiKeyFile === 'string' && apiKeyFile.trim()) {
    const reader = typeof read === 'function' ? read : (path) => readFile(path, 'utf8')
    try {
      const content = await reader(apiKeyFile.trim())
      const line = String(content ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
      if (line) {
        const value = line.slice(line.indexOf('=') + 1).trim()
        if (value) return value
      }
    } catch {
      /* no key from a file we could not read */
    }
  }
  return null
}

/** The injected fetch, or the global one. Throws when neither exists. */
function pickFetch(injected) {
  if (typeof injected === 'function') return injected
  if (typeof globalThis.fetch === 'function') return globalThis.fetch
  throw new Error('systemone: no fetch implementation available (inject one through the fetch option)')
}

/**
 * A timeout signal combined with the caller's own signal.
 *
 * @param {number} timeoutMs
 * @param {AbortSignal|undefined} signal
 * @returns {AbortSignal|undefined}
 */
function deadlineSignal(timeoutMs, signal) {
  const signals = []
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal.timeout === 'function') {
    signals.push(AbortSignal.timeout(Math.floor(timeoutMs)))
  }
  if (signal) signals.push(signal)
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  return signals[0]
}

/** Headers for one call; a missing key is tolerated ONLY for a loopback endpoint. */
async function headersFor({ apiKey, baseURL }) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key) return { 'content-type': 'application/json', authorization: 'Bearer ' + key }
  if (isLoopbackEndpoint(baseURL)) return { 'content-type': 'application/json' }
  throw new Error('systemone: no API key available (check apiKey / apiKeyEnv / apiKeyFile; only a loopback baseURL may run unauthenticated)')
}

/** A short, safe error message from an unknown thrown value. */
function messageOf(error) {
  const message = error && typeof error === 'object' && 'message' in error ? String(/** @type {{message:unknown}} */ (error).message) : String(error)
  return message.slice(0, 300)
}

/**
 * One System One call.
 *
 * @param {object} options
 * @param {string} [options.baseURL] endpoint base; defaults to SiliconFlow.
 * @param {string} [options.model] model id; defaults to {@link DEFAULT_SYSTEMONE_MODEL}.
 * @param {string} [options.apiKey] resolved bearer token.
 * @param {{policy?:string, request?:unknown}} options.state request-side state.
 * @param {Record<string, {type:'choice', instructions:string, criteria:Record<string,string>}>} options.questions
 * @param {number} [options.maxLen] request-side context budget; 0 or absent = inherit the deployment's.
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetch] injected fetch (tests never touch the network).
 * @returns {Promise<{answers: Record<string,{choice:string, confidence?:number, probabilities?:Record<string,number>}>, servedBy?:string}>}
 */
export async function callSystemone({
  baseURL = '',
  model = '',
  apiKey = '',
  state,
  questions,
  maxLen,
  timeoutMs = DEFAULT_SYSTEMONE_TIMEOUT_MS,
  signal,
  fetch: fetchImpl,
} = {}) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '') || DEFAULT_SYSTEMONE_BASE_URL
  const chosenModel = String(model ?? '').trim() || DEFAULT_SYSTEMONE_MODEL
  const doFetch = pickFetch(fetchImpl)

  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('systemone: state must be an object')
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new Error('systemone: questions must be a non-empty map of choice questions')
  }
  const headers = await headersFor({ apiKey, baseURL: base })

  const budget = typeof maxLen === 'number' && Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 0
  const body = {
    model: chosenModel,
    state: {
      policy: typeof state.policy === 'string' ? state.policy : '',
      request: state.request ?? {},
    },
    questions,
    // Sent only when configured: an endpoint deployed with its own budget must
    // keep it (a self-hosted Laya reads an absent argument as "inherit").
    ...(budget > 0 ? { max_len: budget } : {}),
  }

  let response
  try {
    response = await doFetch(base + '/systemone', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: deadlineSignal(timeoutMs, signal),
    })
  } catch (error) {
    throw new Error('systemone request failed: ' + messageOf(error))
  }

  if (!response || response.ok !== true) {
    const detail = await safeText(response)
    throw new Error('systemone HTTP ' + String(response?.status ?? '?') + ': ' + detail.slice(0, 200))
  }

  let data
  try {
    data = await response.json()
  } catch (error) {
    throw new Error('systemone returned a non-JSON body: ' + messageOf(error))
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('systemone returned a non-object body')

  const answers = normalizeAnswers(data)
  if (Object.keys(answers).length === 0) throw new Error('systemone returned no usable answers')
  const servedBy = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined
  return { answers, ...(servedBy ? { servedBy } : {}) }
}

/** Read a response body defensively (never throws). */
async function safeText(response) {
  try {
    if (!response || typeof response.text !== 'function') return ''
    return String(await response.text()).slice(0, 400)
  } catch {
    return ''
  }
}

/**
 * Normalise the response's `answers` map. Entries without a usable string
 * `choice` are dropped (never guessed at); confidences are kept only when they
 * are finite numbers, probabilities only when they are finite numbers.
 *
 * @param {any} data
 * @returns {Record<string,{choice:string, confidence?:number, probabilities?:Record<string,number>}>}
 */
export function normalizeAnswers(data) {
  const raw = data?.answers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('systemone response has no answers map')
  /** @type {Record<string,{choice:string, confidence?:number, probabilities?:Record<string,number>}>} */
  const out = {}
  for (const [qid, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const entry = /** @type {{choice?:unknown, confidence?:unknown, probabilities?:unknown}} */ (value)
    const choice = typeof entry.choice === 'string' ? entry.choice : null
    if (choice === null || choice.trim() === '') continue
    /** @type {{choice:string, confidence?:number, probabilities?:Record<string,number>}} */
    const normalized = { choice }
    if (typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)) normalized.confidence = entry.confidence
    if (entry.probabilities && typeof entry.probabilities === 'object' && !Array.isArray(entry.probabilities)) {
      /** @type {Record<string,number>} */
      const probabilities = {}
      for (const [label, p] of Object.entries(/** @type {Record<string,unknown>} */ (entry.probabilities))) {
        if (typeof p === 'number' && Number.isFinite(p)) probabilities[label] = p
      }
      if (Object.keys(probabilities).length > 0) normalized.probabilities = probabilities
    }
    out[qid] = normalized
  }
  return out
}

/** The risk vocabulary shared with the classifier and the arbiter. */
export const SYSTEMONE_RISK_VALUES = RISK_VALUES
