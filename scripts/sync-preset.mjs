#!/usr/bin/env node
/**
 * Generate the AIDLC-mode agent preset into this bundle's `cordis.patch.yml`.
 *
 * ## Why a generator, and why the app archive
 *
 * DeepSeek Harness v0.2.1 replaced the directory-scanned preset system: a preset
 * is now a `@deepseek-ai/dsh-agent-preset` row carrying an explicit `plugins`
 * child list, and the shipped ones live inside the application archive
 * (`app.asar` -> `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/`). The
 * registry "neither scans directories nor accepts preset paths", so a bundle
 * cannot ship a preset as files — it has to carry a patch row.
 *
 * Deriving that row from the shipped `standard` declaration instead of shipping
 * a hand-maintained copy is what keeps the mode from drifting: AIDLC mode IS
 * standard mode, so when the harness upgrades `standard` (new tools, new
 * passive rows), a regeneration picks the change up instead of silently pinning
 * an old composition. That was the one limitation this generator exists to
 * remove.
 *
 * ## Why the transform is textual
 *
 * A YAML round-trip is unusable here. `js-yaml`/`yaml` drop the loader's custom
 * `!!js` tag, which turns
 *
 *     disabled: !!js process.platform === 'win32'
 *
 * into the STRING `"process.platform === 'win32'"` — truthy — so the row would
 * be disabled on every platform. In this composition that silently removes BOTH
 * shells from the new mode. So the declaration is edited as text and the `!!js`
 * occurrences are asserted afterwards.
 *
 * Usage:
 *   node scripts/sync-preset.mjs            # regenerate in place
 *   node scripts/sync-preset.mjs --check     # exit 1 when stale (CI / npm run check)
 *   DSH_ASAR=<path> node scripts/sync-preset.mjs
 *
 * @module dsh-aidlc/scripts/sync-preset
 */
import { openSync, readSync, closeSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH_FILE = join(ROOT, 'cordis.patch.yml')

/** The shipped preset this mode is derived from. */
const SOURCE_PRESET_ID = 'standard'
/** The id this bundle publishes. Must match `AIDLC_PRESET_ID` in lib/presets.js. */
const TARGET_PRESET_ID = 'aidlc'
/** Row id inside the profile entry list; stable so a profile patch can override it. */
const TARGET_ROW_ID = 'preset-aidlc'
/** Sorts after the shipped four (standard 1, ptc 2, minimal 3, cordis 4). */
const TARGET_ORDER = 5

/** Human-facing copy. v0.2.1 never translates a declaration's own metadata. */
const TARGET_NAME = 'AIDLC 模式'
const TARGET_DESCRIPTION =
  '标准模式的全部能力 + AI-DLC 生命周期：意图 → 设计门 → 构建 → 交付门 → 运维，工件链落 docs/aidlc/。决策模型先行判定，只在它拿不准时才打断你。 | Standard mode plus the AI-DLC lifecycle: intent → design gate → construction → delivery gate → operations, with an artifact chain under docs/aidlc/. The decision model is consulted first and only interrupts you when it is unsure.'

const BEGIN = '# ── BEGIN generated: AIDLC mode preset (scripts/sync-preset.mjs) ──'
const END = '# ── END generated: AIDLC mode preset ──'

const ASAR = process.env.DSH_ASAR
  || 'D:/Program Files (x86)/DeepseekHarness/resources/app.asar'

/**
 * Read one file out of an ASAR archive.
 *
 * ASAR is a pickle header (8 bytes) plus a 4-byte JSON length and the JSON
 * directory; file bodies follow the header contiguously, each addressed by its
 * `offset`. Reading two small files needs no dependency.
 *
 * @param {string} archive - path to app.asar.
 * @param {RegExp} match - matcher for the desired archive path.
 * @returns {string|null} the file's text, or null when absent.
 */
function readFromAsar (archive, match) {
  if (!existsSync(archive)) return null
  const fd = openSync(archive, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    const dirBuf = Buffer.alloc(jsonLength)
    readSync(fd, dirBuf, 0, jsonLength, 16)
    const baseOffset = 16 + jsonLength
    const directory = JSON.parse(dirBuf.toString('utf8'))
    /** @type {{path:string,size:number,offset:number}[]} */
    const files = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix === '' ? name : `${prefix}/${name}`
        if (child.files) walk(child, p)
        else files.push({ path: p, size: child.size, offset: child.offset })
      }
    }
    walk(directory, '')
    const found = files.find((f) => match.test(f.path))
    if (found === undefined) return null
    const body = Buffer.alloc(found.size)
    readSync(fd, body, 0, found.size, baseOffset + Number(found.offset))
    return body.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Build the declaration text from the shipped source. */
function buildDeclaration () {
  const source = readFromAsar(
    ASAR,
    new RegExp(`dsh-web-app/presets/${SOURCE_PRESET_ID}\\.patch\\.yml$`),
  )
  if (source === null) {
    throw new Error(
      `could not find the shipped "${SOURCE_PRESET_ID}" preset in ${ASAR}. ` +
        'Set DSH_ASAR to this installation\'s app.asar.',
    )
  }
  const jsBefore = (source.match(/!!js/g) || []).length
  if (jsBefore === 0) {
    throw new Error(
      'the shipped declaration carries no `!!js` conditions, which is unexpected — ' +
        'refusing to generate rather than emit a composition with no conditional rows.',
    )
  }

  let decl = source
  // Drop the source's header comment; this file explains itself.
  decl = decl.replace(/^#[\s\S]*?(?=\n- insert:)/, '')

  decl = decl.replace(`- id: preset-${SOURCE_PRESET_ID}`, `- id: ${TARGET_ROW_ID}`)
  decl = decl.replace(new RegExp(`^(\\s+id:) ${SOURCE_PRESET_ID}$`, 'm'), `$1 ${TARGET_PRESET_ID}`)
  decl = decl.replace(/^(\s+order:) \d+$/m, `$1 ${TARGET_ORDER}`)

  // Publish the row's own display copy, which v0.2.1 never translates.
  decl = decl.replace(
    /^(\s+id:) .*$/m,
    (line) => line,
  )
  const configIndent = '        '
  decl = decl.replace(
    new RegExp(`^(${configIndent}order: ${TARGET_ORDER})$`, 'm'),
    [
      '$1',
      `${configIndent}name: ${JSON.stringify(TARGET_NAME)}`,
      `${configIndent}description: ${JSON.stringify(TARGET_DESCRIPTION)}`,
    ].join('\n'),
  )

  // The mode statement lives in the persona: it must reach the model in the
  // first request, and this is the only prompt slot a preset declaration owns.
  const PERSONA_OLD = '              prefix: You are a coding agent powered by the {{model}} model.'
  const PERSONA_NEW = [
    '              prefix: |-',
    '                You are a coding agent powered by the {{model}} model.',
    '',
    '                YOU ARE IN AI-DLC MODE. When the user describes something to build or change,',
    '                begin it — load the `aidlc` skill and run its entry protocol, without waiting',
    '                for a command. The decision model is consulted first at each decision point and',
    '                a human only when it is unsure; the gates are the exception and stay human by',
    '                default. Gates and guards are unchanged by the mode.',
  ].join('\n')
  if (!decl.includes(PERSONA_OLD)) {
    throw new Error(
      'the persona prefix line moved in the shipped declaration; update PERSONA_OLD in ' +
        'scripts/sync-preset.mjs rather than emitting a mode with no statement.',
    )
  }
  decl = decl.replace(PERSONA_OLD, PERSONA_NEW)

  const jsAfter = (decl.match(/!!js/g) || []).length
  if (jsAfter !== jsBefore) {
    throw new Error(
      `the transform changed the number of \`!!js\` tags (${jsBefore} -> ${jsAfter}); ` +
        'a conditional row would silently change meaning.',
    )
  }
  return decl.trimEnd()
}

/** Compose the marked block that goes into cordis.patch.yml. */
function buildBlock () {
  return [
    BEGIN,
    '#',
    '# AIDLC mode: `standard` mode plus this plugin, declared the way v0.2.1 reads',
    '# presets (a row with an explicit `plugins` list — the registry scans no',
    '# directories). Deriving it from the installed `standard` declaration is what',
    '# keeps the mode current across harness upgrades.',
    '#',
    '# Regenerate with: node scripts/sync-preset.mjs',
    buildDeclaration(),
    END,
  ].join('\n')
}

/** Replace the marked block in a patch document. */
function splice (existing, block) {
  const start = existing.indexOf(BEGIN)
  if (start === -1) {
    return `${existing.trimEnd()}\n\n${block}\n`
  }
  const end = existing.indexOf(END)
  if (end === -1) throw new Error('found the generated-block start marker without its end marker')
  return existing.slice(0, start) + block + existing.slice(end + END.length)
}

function main () {
  const check = process.argv.includes('--check')
  const block = buildBlock()
  const current = existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, 'utf8') : ''
  const next = splice(current, block)
  if (check) {
    if (next !== current) {
      console.log('cordis.patch.yml: the generated AIDLC-mode preset is STALE. Run: node scripts/sync-preset.mjs')
      process.exit(1)
    }
    console.log('cordis.patch.yml: generated AIDLC-mode preset is current')
    return
  }
  if (next === current) {
    console.log('cordis.patch.yml: already current')
    return
  }
  writeFileSync(PATCH_FILE, next, 'utf8')
  console.log(`cordis.patch.yml: wrote the "${TARGET_NAME}" preset declaration from the installed ${SOURCE_PRESET_ID}`)
}

main()
