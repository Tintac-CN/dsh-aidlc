/**
 * Per-role model pins + the resolved decision endpoint.
 *
 * Three things are pinned here, and they are the three ways this feature could
 * lie to an operator:
 *
 *  1. **a pin that does not apply.** A half-supplied `provider`/`model` pair, or
 *     an unknown role id, must resolve to "not pinned" with a visible reason —
 *     never to a silent success.
 *  2. **a dispatch that ignores the pin.** `aidlc_dispatch_role` must pass the
 *     resolved route into the subagent request, and must REFUSE (not fall back
 *     to the session route) when the route cannot be used.
 *  3. **a report that hides the route.** The tool result and `/aidlc-doctor`
 *     both name the route that was actually applied, including the inherited
 *     one, so "no model pinned" and "the pin did not work" are distinguishable.
 *
 * The harness-facing parts run against fakes: no subagent is started, no model
 * is contacted, and nothing here needs a running harness.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AIDLC_ROLES, Config, configWarnings, plainConfig, resolveRolePin, validateConfig } from '../lib/config.js'
import { DEFAULT_SYSTEMONE_BASE_URL, DEFAULT_SYSTEMONE_MODEL, resolveDecisionEndpoint } from '../lib/decision/reviewer.js'
import {
  formatDecisionEndpoint,
  formatRoleDispatch,
  preflightRolePin,
  registerTools,
  rolePinRows,
  runDoctor,
} from '../lib/surface/tools.js'

const silentLog = { warn() {}, error() {}, info() {} }

/* ────────────────────────────── the role vocabulary ───────────────────────── */

test('the ten AI-DLC roles are the single vocabulary, and every pin defaults to inherit', () => {
  assert.deepEqual(AIDLC_ROLES, ['pm', 'architect', 'dev', 'qa', 'tea', 'verifier', 'reviewer-pm', 'reviewer-architect', 'reviewer-qa', 'reviewer-dev'])
  const cfg = plainConfig(new Config({}))
  assert.deepEqual(Object.keys(cfg.roles).sort(), [...AIDLC_ROLES].sort())
  for (const role of AIDLC_ROLES) {
    const pin = resolveRolePin(cfg.roles, role)
    assert.equal(pin.pinned, false, `${role} must not be pinned by default`)
    assert.equal(pin.provider, '')
    assert.equal(pin.model, '')
  }
  // The default behaviour is unchanged: a default config is valid and silent.
  assert.equal(validateConfig(cfg), null)
  assert.deepEqual(configWarnings(cfg), [])
})

test('a complete pin resolves; an incomplete one does NOT pretend to resolve', () => {
  const cfg = plainConfig(new Config({ roles: { qa: { provider: 'deepseek', model: 'cheap' }, dev: { provider: 'deepseek' }, pm: { model: 'solo' } } }))
  assert.deepEqual(resolveRolePin(cfg.roles, 'qa'), { role: 'qa', provider: 'deepseek', model: 'cheap', pinned: true, reason: '' })
  for (const role of ['dev', 'pm']) {
    const pin = resolveRolePin(cfg.roles, role)
    assert.equal(pin.pinned, false, `${role} is half-pinned, so it must not claim to be pinned`)
    assert.match(pin.reason, /incomplete pin/)
  }
  // Whitespace is not a route.
  const blank = plainConfig(new Config({ roles: { qa: { provider: '  ', model: '  ' } } }))
  assert.equal(resolveRolePin(blank.roles, 'qa').pinned, false)
})

test('an unknown role id is an advisory, not a silent no-op', () => {
  const cfg = plainConfig(new Config({ roles: { qa: { provider: 'p', model: 'm' }, qaa: { provider: 'p', model: 'm' } } }))
  const warnings = configWarnings(cfg)
  assert.equal(warnings.length, 1, 'exactly the unknown role warns')
  assert.match(warnings[0], /roles\.qaa is not an AI-DLC role/)
  assert.match(warnings[0], /does nothing/)
  // The known pin is still applied, and the layer is NOT disarmed by a typo.
  assert.equal(validateConfig(cfg), null)
  assert.equal(resolveRolePin(cfg.roles, 'qa').pinned, true)
})

test('a half-supplied pin is an advisory and never disarms the decision layer', () => {
  const cfg = plainConfig(new Config({ roles: { verifier: { provider: 'deepseek' } } }))
  const warnings = configWarnings(cfg)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /roles\.verifier: incomplete pin/)
  assert.equal(validateConfig(cfg), null, 'a role pin is a cost choice, not a safety switch: it must not disarm anything')
})

test('rolePinRows reports every role, including the inheriting ones', () => {
  const cfg = plainConfig(new Config({ roles: { verifier: { provider: 'deepseek', model: 'strong' }, qa: { provider: 'deepseek' } } }))
  const rows = rolePinRows(cfg.roles)
  assert.equal(rows.length, AIDLC_ROLES.length)
  const verifier = rows.find((r) => r.role === 'verifier')
  assert.equal(verifier.pinned, true)
  assert.match(verifier.line, /verifier\s+deepseek\/strong/)
  const qa = rows.find((r) => r.role === 'qa')
  assert.match(qa.line, /inherit the session route/)
  assert.match(qa.line, /incomplete pin/, 'the reason travels with the row, so the doctor shows WHY a pin is inert')
  const pm = rows.find((r) => r.role === 'pm')
  assert.match(pm.line, /inherit the session route/)
  assert.doesNotMatch(pm.line, /incomplete/, 'an unconfigured role is not a defect and must not read like one')
})

/* ──────────────────────────── the resolved endpoint ───────────────────────── */

test('resolveDecisionEndpoint mirrors the wiring: systemone defaults, chat has none, session ignores model', () => {
  const systemone = resolveDecisionEndpoint({ protocol: 'systemone', baseURL: '', model: '' })
  assert.equal(systemone.baseURL, DEFAULT_SYSTEMONE_BASE_URL)
  assert.equal(systemone.model, DEFAULT_SYSTEMONE_MODEL)
  assert.equal(systemone.baseURLSource, 'the protocol default')
  assert.equal(systemone.authenticated, false)

  const configured = resolveDecisionEndpoint({ protocol: 'systemone', baseURL: 'http://127.0.0.1:8080/v1', model: 'laya-local', apiKeyEnv: 'JEV_KEY' })
  assert.equal(configured.baseURL, 'http://127.0.0.1:8080/v1')
  assert.equal(configured.model, 'laya-local')
  assert.equal(configured.baseURLSource, 'decision.model.baseURL')
  assert.equal(configured.keySource, 'decision.model.apiKeyEnv (JEV_KEY)')
  assert.equal(configured.authenticated, true)

  const chat = resolveDecisionEndpoint({ protocol: 'chat' })
  assert.equal(chat.baseURL, null)
  assert.equal(chat.model, null)
  assert.match(chat.note, /no default base URL/)
  assert.match(chat.note, /no decision\.model\.model/)

  // The session transport resolves the running route per call: a model here is
  // NOT what gets used, and saying otherwise would be the mispointing this
  // doctor exists to expose.
  const session = resolveDecisionEndpoint({ protocol: 'session', model: 'ignored-model' })
  assert.equal(session.model, null)
  assert.match(session.note, /IGNORED/)
  assert.match(formatDecisionEndpoint(session), /protocol session/)
  assert.match(formatDecisionEndpoint(systemone), /api\.siliconflow\.cn/)
})

test('the endpoint report never prints key material', () => {
  const secret = 'sk-do-not-print-me'
  const endpoint = resolveDecisionEndpoint({ protocol: 'systemone', apiKey: secret })
  const line = formatDecisionEndpoint(endpoint)
  assert.equal(line.includes(secret), false, 'the doctor names the key SOURCE, never the key')
  assert.match(line, /decision\.model\.apiKey \(literal\)/)
})

/* ─────────────────────────── preflight of a role pin ──────────────────────── */

const ctxWith = (services) => ({
  get: (name) => services[name],
})

test('preflightRolePin THROWS for an unregistered provider and for an unresolvable model', async () => {
  const llmOk = { listProviders: () => [{ id: 'deepseek' }], resolveModelInfo: async () => ({ id: 'm' }) }
  const llmBad = { listProviders: () => [{ id: 'deepseek' }], resolveModelInfo: async () => { throw new Error('unknown model "nope"') } }
  await assert.rejects(
    () => preflightRolePin(ctxWith({ llm: llmOk }), { role: 'qa', provider: 'ghost', model: 'm' }, undefined),
    /pinned to LLM provider "ghost", which is not registered.*registered: deepseek/s,
  )
  await assert.rejects(
    () => preflightRolePin(ctxWith({ llm: llmBad }), { role: 'verifier', provider: 'deepseek', model: 'nope' }, undefined),
    /roles\.verifier is pinned to "deepseek\/nope" and that model did not resolve.*The child was NOT started/s,
  )
})

test('preflightRolePin warns (never refuses) when the deployment allow-list excludes the route, and when llm is absent', async () => {
  const settings = { current: () => ({ enabled: true, allowedModels: [{ provider: 'deepseek', model: 'other' }] }) }
  const llm = { listProviders: () => [{ id: 'deepseek' }], resolveModelInfo: async () => ({}) }
  const excluded = await preflightRolePin(ctxWith({ llm, subagentModelSelection: settings }), { role: 'qa', provider: 'deepseek', model: 'cheap' }, undefined)
  assert.equal(excluded.warnings.length, 1)
  assert.match(excluded.warnings[0], /allow-list does not include deepseek\/cheap/)
  assert.match(excluded.warnings[0], /applied anyway/)

  const allowed = await preflightRolePin(
    ctxWith({ llm, subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [{ provider: 'deepseek', model: 'cheap' }] }) } }),
    { role: 'qa', provider: 'deepseek', model: 'cheap' },
    undefined,
  )
  assert.deepEqual(allowed.warnings, [])

  const noLlm = await preflightRolePin(ctxWith({}), { role: 'qa', provider: 'deepseek', model: 'cheap' }, undefined)
  assert.equal(noLlm.warnings.length, 1)
  assert.match(noLlm.warnings[0], /no `llm` service is visible/)
})

/* ───────────────────────────── the dispatch tool ──────────────────────────── */

const fakeContext = ({ subagents, llm, settings } = {}) => {
  const tools = []
  const services = { subagents, llm, subagentModelSelection: settings }
  const ctx = {
    tools: { register: (tool) => tools.push(tool), get: () => undefined },
    get: (name) => services[name],
    logger: () => silentLog,
  }
  return { ctx, tools }
}

const fakeSubagents = ({ capabilities = { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } } = {}) => {
  const specs = []
  return {
    specs,
    service: {
      list: () => ['spawn'],
      getProvider: (name) => (name === 'spawn' ? { name: 'spawn', capabilities, inheritsParentContext: false } : undefined),
      startActivation: async (spec) => {
        specs.push(spec)
        return { childId: 'child-1', messageId: 'msg-1' }
      },
    },
  }
}

const register = (services, config) => {
  const { ctx, tools } = fakeContext(services)
  const result = registerTools({ ctx, deps: { config, log: silentLog } })
  return { ctx, tools, result }
}

test('aidlc_dispatch_role registers, and dispatches a pinned role with its configured route', async (t) => {
  const { service, specs } = fakeSubagents()
  const llm = { listProviders: () => [{ id: 'deepseek' }], resolveModelInfo: async () => ({}) }
  const cfg = plainConfig(new Config({ roles: { verifier: { provider: 'deepseek', model: 'strong' } } }))
  const { tools, result } = register({ subagents: service, llm }, cfg)
  if (result.ok === false) {
    t.skip('@deepseek-ai/dsh-tools is not installed in this checkout')
    return
  }
  assert.deepEqual(result.tools, ['aidlc_status', 'aidlc_classify', 'aidlc_decide', 'aidlc_record_decision', 'aidlc_dispatch_role'])
  const tool = tools.find((x) => x.name === 'aidlc_dispatch_role')
  assert.deepEqual(tool.parameters.properties.role.enum, AIDLC_ROLES)

  const out = await tool.execute({ role: 'verifier', prompt: 'READ x, WRITE y, finish with VERIFIER-DONE <path> <hash>' }, { agent: { id: 'parent' } })
  assert.equal(specs.length, 1)
  assert.equal(specs[0].provider, 'spawn')
  assert.equal(specs[0].delivery, 'parent')
  assert.deepEqual(specs[0].request.agentOptions, { provider: 'deepseek', model: 'strong' })
  assert.equal(specs[0].request.parent.id, 'parent')
  assert.equal(out.pinned, true)
  assert.equal(out.route, 'deepseek/strong')
  assert.equal(out.subagentId, 'child-1')
  assert.match(out.report, /model route: deepseek\/strong — pinned by config\.roles\.verifier/)
})

test('an unpinned role dispatches with NO agentOptions — byte-for-byte today\'s behaviour', async (t) => {
  const { service, specs } = fakeSubagents()
  const cfg = plainConfig(new Config({}))
  const { tools, result } = register({ subagents: service }, cfg)
  if (result.ok === false) {
    t.skip('@deepseek-ai/dsh-tools is not installed in this checkout')
    return
  }
  const tool = tools.find((x) => x.name === 'aidlc_dispatch_role')
  const out = await tool.execute({ role: 'qa', prompt: 'write test-strategy.md' }, { agent: { id: 'parent' } })
  assert.equal('agentOptions' in specs[0].request, false, 'an unpinned role must inherit, not be given an empty route')
  assert.equal(out.pinned, false)
  assert.equal(out.route, 'inherited (the session route)')
  assert.match(out.report, /no pin configured for this role/)
})

test('a half-supplied pin dispatches inherited AND says why', async (t) => {
  const { service, specs } = fakeSubagents()
  const cfg = plainConfig(new Config({ roles: { dev: { provider: 'deepseek' } } }))
  const { tools, result } = register({ subagents: service }, cfg)
  if (result.ok === false) {
    t.skip('@deepseek-ai/dsh-tools is not installed in this checkout')
    return
  }
  const tool = tools.find((x) => x.name === 'aidlc_dispatch_role')
  const out = await tool.execute({ role: 'dev', prompt: 'implement U1' }, { agent: { id: 'parent' } })
  assert.equal('agentOptions' in specs[0].request, false)
  assert.equal(out.pinned, false)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /incomplete pin/)
  assert.match(out.report, /WARNING: config\.roles\.dev: incomplete pin/)
})

test('aidlc_dispatch_role refuses rather than silently un-pinning', async (t) => {
  const cfg = plainConfig(new Config({ roles: { verifier: { provider: 'ghost', model: 'strong' } } }))
  const llm = { listProviders: () => [{ id: 'deepseek' }], resolveModelInfo: async () => ({}) }
  const { service, specs } = fakeSubagents()
  const { tools, result } = register({ subagents: service, llm }, cfg)
  if (result.ok === false) {
    t.skip('@deepseek-ai/dsh-tools is not installed in this checkout')
    return
  }
  const tool = tools.find((x) => x.name === 'aidlc_dispatch_role')
  await assert.rejects(() => tool.execute({ role: 'verifier', prompt: 'x' }, { agent: { id: 'p' } }), /not registered in this deployment/)
  assert.equal(specs.length, 0, 'nothing may be started when the pin cannot be honoured')

  // No subagents service at all: refuse, and say the plain tool cannot pin either.
  const none = register({}, cfg)
  if (none.result.ok === false) return
  const noneTool = none.tools.find((x) => x.name === 'aidlc_dispatch_role')
  await assert.rejects(() => noneTool.execute({ role: 'qa', prompt: 'x' }, { agent: { id: 'p' } }), /no `subagents` service/)

  // A provider that cannot take agentOptions at all.
  const limited = fakeSubagents({ capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } })
  const limitedReg = register({ subagents: limited.service }, plainConfig(new Config({ roles: { qa: { provider: 'p', model: 'm' } } })))
  if (limitedReg.result.ok === false) return
  const limitedTool = limitedReg.tools.find((x) => x.name === 'aidlc_dispatch_role')
  await assert.rejects(() => limitedTool.execute({ role: 'qa', prompt: 'x' }, { agent: { id: 'p' } }), /does not advertise the child "agentOptions" capability/)

  // Empty prompt and missing caller are refused before anything is started.
  const ok = fakeSubagents()
  const okReg = register({ subagents: ok.service }, plainConfig(new Config({})))
  if (okReg.result.ok === false) return
  const okTool = okReg.tools.find((x) => x.name === 'aidlc_dispatch_role')
  await assert.rejects(() => okTool.execute({ role: 'qa', prompt: '   ' }, { agent: { id: 'p' } }), /"prompt" is empty/)
  await assert.rejects(() => okTool.execute({ role: 'qa', prompt: 'x' }, {}), /exec\.agent was undefined/)
  assert.equal(ok.specs.length, 0)
})

test('formatRoleDispatch always names the applied route', () => {
  const text = formatRoleDispatch({ role: 'qa', label: 'AIDLC qa', childId: 'c1', route: 'inherited (the session route)', pinned: false, warnings: ['w1'] })
  assert.match(text, /started role "qa" as subagent c1/)
  assert.match(text, /model route: inherited \(the session route\) — no pin configured for this role/)
  assert.match(text, /WARNING: w1/)
})

/* ─────────────────────────────── the doctor ───────────────────────────────── */

test('/aidlc-doctor reports the resolved endpoint and every role\'s route', async () => {
  const { service } = fakeSubagents()
  const { ctx } = fakeContext({ subagents: service })
  const cfg = plainConfig(new Config({
    roles: { verifier: { provider: 'deepseek', model: 'strong' }, qa: { provider: 'deepseek' } },
    decision: { model: { protocol: 'systemone', baseURL: '', model: '', apiKey: 'sk-literal' } },
  }))
  const result = await runDoctor({ deps: { config: cfg, decisionEnabled: true, log: silentLog }, root: '/nonexistent-root', ctx })
  const endpoint = result.checks.find((c) => c.name === 'Decision endpoint (resolved)')
  assert.ok(endpoint, 'the doctor must report the resolved endpoint')
  assert.equal(endpoint.status, 'OK')
  assert.match(endpoint.detail, new RegExp(DEFAULT_SYSTEMONE_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(endpoint.detail, new RegExp(DEFAULT_SYSTEMONE_MODEL))
  assert.match(endpoint.detail, /decision\.model\.apiKey \(literal\)/)
  assert.equal(endpoint.detail.includes('sk-literal'), false, 'never print the key')

  const roles = result.checks.find((c) => c.name === 'Per-role models')
  assert.ok(roles, 'the doctor must report per-role models')
  assert.equal(roles.status, 'FAIL', 'a half-supplied pin is a mispointing and must not read as a pass')
  assert.match(roles.detail, /verifier\s+deepseek\/strong/)
  assert.match(roles.detail, /qa\s+inherit the session route — incomplete pin/)
  assert.match(roles.detail, /applicability: `aidlc_dispatch_role` can apply a pin/)
  assert.match(roles.detail, /WARNING: roles\.qa: incomplete pin/)
})

test('/aidlc-doctor FAILs per-role models when a pin is configured but cannot be applied', async () => {
  const limited = fakeSubagents({ capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } })
  const { ctx } = fakeContext({ subagents: limited.service })
  const cfg = plainConfig(new Config({ roles: { verifier: { provider: 'deepseek', model: 'strong' } } }))
  const result = await runDoctor({ deps: { config: cfg, decisionEnabled: true, log: silentLog }, root: '/nonexistent-root', ctx })
  const roles = result.checks.find((c) => c.name === 'Per-role models')
  assert.equal(roles.status, 'FAIL')
  assert.match(roles.detail, /cannot apply a per-role model route at all/)

  // With NO pins configured, an incapable harness is not a defect: nothing was promised.
  const unpinned = await runDoctor({ deps: { config: plainConfig(new Config({})), decisionEnabled: true, log: silentLog }, root: '/nonexistent-root', ctx })
  assert.equal(unpinned.checks.find((c) => c.name === 'Per-role models').status, 'OK')
})

test('/aidlc-doctor FAILs the endpoint check for a chat endpoint missing its base URL or model', async () => {
  const { ctx } = fakeContext({})
  const cfg = plainConfig(new Config({ decision: { model: { protocol: 'chat' } } }))
  const result = await runDoctor({ deps: { config: cfg, decisionEnabled: true, log: silentLog }, root: '/nonexistent-root', ctx })
  const endpoint = result.checks.find((c) => c.name === 'Decision endpoint (resolved)')
  assert.equal(endpoint.status, 'FAIL')
  assert.match(endpoint.detail, /no default base URL|missing/i)
})
