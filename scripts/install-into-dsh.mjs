#!/usr/bin/env node

import { access, cp, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const COMPATIBLE_DSH_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetRoot = resolve(process.argv[2] ?? '')
const force = process.argv.includes('--force')

if (process.argv[2] === undefined || process.argv[2].startsWith('--')) {
  console.error('Usage: node scripts/install-into-dsh.mjs /path/to/deepseek-harness [--force]')
  process.exit(2)
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function read(path) {
  return readFile(join(targetRoot, path), 'utf8')
}

async function replaceOnce(path, before, after) {
  const absolute = join(targetRoot, path)
  const source = await readFile(absolute, 'utf8')
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${path}: compatible insertion point not found`)
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`${path}: insertion point is ambiguous`)
  await writeFile(absolute, source.replace(before, after))
}

function git(...args) {
  return execFileSync('git', ['-C', targetRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const rootManifest = JSON.parse(await read('package.json'))
if (rootManifest.name !== '@deepseek-ai/dsh-root') throw new Error(`${targetRoot} is not a DeepSeek Harness checkout`)
const head = git('rev-parse', 'HEAD')
if (head !== COMPATIBLE_DSH_COMMIT) {
  throw new Error(`DSH checkout must be at tested commit ${COMPATIBLE_DSH_COMMIT}; received ${head}`)
}
if (!force && git('status', '--porcelain').length > 0) {
  throw new Error('DSH checkout must be clean; commit or stash changes, or pass --force only after review')
}

const packages = [
  ['packages/voice/voice', 'packages/voice/voice'],
  ['packages/voice/voice-openai-realtime', 'packages/voice/voice-openai-realtime'],
  ['packages/client/wake-word-local', 'packages/client/wake-word-local'],
  ['packages/client/ui-voice', 'packages/client/ui-voice'],
]

for (const [, target] of packages) {
  if (!force && await exists(join(targetRoot, target))) {
    throw new Error(`${target} already exists; remove it or pass --force after reviewing local changes`)
  }
}
for (const [source, target] of packages) {
  await cp(join(repositoryRoot, source), join(targetRoot, target), { recursive: true, force })
}
await cp(join(repositoryRoot, 'packages/voice/README.md'), join(targetRoot, 'packages/voice/README.md'), { force })

await replaceOnce(
  'tsconfig.base.json',
  '      "@deepseek-ai/dsh-api-remotes/invariant": ["./packages/api/remotes/src/invariant.ts"],\n',
  '      "@deepseek-ai/dsh-api-remotes/invariant": ["./packages/api/remotes/src/invariant.ts"],\n      "@deepseek-ai/dsh-voice": ["./packages/voice/voice/src/index.ts"],\n      "@deepseek-ai/dsh-voice/types": ["./packages/voice/voice/src/types.ts"],\n      "@deepseek-ai/dsh-voice/invariant": ["./packages/voice/voice/src/invariant.ts"],\n',
)
await replaceOnce(
  'tsconfig.client.json',
  '    { "path": "./packages/client/ui-conversation" },\n',
  '    { "path": "./packages/client/ui-conversation" },\n    { "path": "./packages/client/wake-word-local" },\n    { "path": "./packages/client/ui-voice" },\n',
)
await replaceOnce(
  'tsconfig.host.json',
  '    { "path": "./packages/feedback/message-feedback" },\n',
  '    { "path": "./packages/feedback/message-feedback" },\n    { "path": "./packages/voice/voice" },\n    { "path": "./packages/voice/voice-openai-realtime" },\n',
)
await replaceOnce(
  'packages/api/remotes/tsconfig.client.json',
  '    {\n      "path": "../../typert/protocol"\n    }\n',
  '    {\n      "path": "../../typert/protocol"\n    },\n    {\n      "path": "../../voice/voice"\n    }\n',
)
await replaceOnce(
  'packages/api/remotes/src/client/index.ts',
  "import sessionReferencesRemote from '@deepseek-ai/dsh-session-reference/remote'\n",
  "import sessionReferencesRemote from '@deepseek-ai/dsh-session-reference/remote'\nimport voiceRemote from '@deepseek-ai/dsh-voice/remote'\n",
)
await replaceOnce(
  'packages/api/remotes/src/client/index.ts',
  "export type {} from '@deepseek-ai/dsh-session-reference/remote'\n",
  "export type {} from '@deepseek-ai/dsh-session-reference/remote'\nexport type {} from '@deepseek-ai/dsh-voice/remote'\n",
)
await replaceOnce(
  'packages/api/remotes/src/client/index.ts',
  '      pluginInventoryRemote, messageFeedbackRemote, sessionReferencesRemote,\n',
  '      pluginInventoryRemote, messageFeedbackRemote, sessionReferencesRemote, voiceRemote,\n',
)
await replaceOnce(
  'packages/api/remotes/package.json',
  '    "@deepseek-ai/dsh-typert-protocol": "workspace:^"\n  },\n  "peerDependencies": {',
  '    "@deepseek-ai/dsh-typert-protocol": "workspace:^",\n    "zod": "^4.4.3"\n  },\n  "peerDependencies": {',
)
await replaceOnce(
  'packages/api/remotes/package.json',
  '    "@deepseek-ai/dsh-typert-registry": "workspace:^",\n    "@deepseek-ai/cordis": "workspace:^"\n  },\n  "devDependencies": {',
  '    "@deepseek-ai/dsh-typert-registry": "workspace:^",\n    "@deepseek-ai/dsh-voice": "workspace:^",\n    "@deepseek-ai/cordis": "workspace:^"\n  },\n  "devDependencies": {',
)
await replaceOnce(
  'packages/api/remotes/package.json',
  '    "@deepseek-ai/dsh-typert-registry": "workspace:^",\n    "@deepseek-ai/cordis": "workspace:^"\n  }\n}',
  '    "@deepseek-ai/dsh-typert-registry": "workspace:^",\n    "@deepseek-ai/dsh-voice": "workspace:^",\n    "@deepseek-ai/cordis": "workspace:^"\n  }\n}',
)
await replaceOnce(
  'packages/bundle/web-app/package.json',
  '    "@deepseek-ai/dsh-client-ui-user-questions": "workspace:^",\n',
  '    "@deepseek-ai/dsh-client-ui-user-questions": "workspace:^",\n    "@deepseek-ai/dsh-client-ui-voice": "workspace:^",\n',
)
await replaceOnce(
  'packages/bundle/web-app/package.json',
  '    "@deepseek-ai/dsh-client-ui-workspace": "workspace:^",\n',
  '    "@deepseek-ai/dsh-client-ui-workspace": "workspace:^",\n    "@deepseek-ai/dsh-client-wake-word-local": "workspace:^",\n',
)
await replaceOnce(
  'packages/bundle/web-app/package.json',
  '    "@deepseek-ai/dsh-workspace": "workspace:^",\n',
  '    "@deepseek-ai/dsh-workspace": "workspace:^",\n    "@deepseek-ai/dsh-voice": "workspace:^",\n    "@deepseek-ai/dsh-voice-openai-realtime": "workspace:^",\n',
)
await replaceOnce(
  'packages/bundle/web-app/cordis.patch.yml',
  '    # Browser Session export: `/export` command plus the shared download dialog.\n',
  "    # Optional Host broker for wake-gated OpenAI Realtime calls.\n    - id: voice-openai-realtime\n      name: '@deepseek-ai/dsh-voice-openai-realtime'\n      config:\n        model: gpt-realtime-2.1\n        transcriptionModel: gpt-4o-mini-transcribe\n        voice: cedar\n        maxSessionSeconds: 3300\n        maxResponseOutputTokens: 768\n\n    # Browser Session export: `/export` command plus the shared download dialog.\n",
)
await replaceOnce(
  'packages/bundle/web-app/cordis.patch.yml',
  "    - id: ui-brand-official\n      name: '@deepseek-ai/dsh-client-ui-brand-official'\n",
  "    # Speaker-calibrated browser matcher for the literal keyword БРО.\n    - id: wake-word-local\n      name: '@deepseek-ai/dsh-client-wake-word-local'\n\n    # Session push-to-talk and hands-free voice controls.\n    - id: ui-voice\n      name: '@deepseek-ai/dsh-client-ui-voice'\n\n    - id: ui-brand-official\n      name: '@deepseek-ai/dsh-client-ui-brand-official'\n",
)

console.log(`Installed dsh-voice-bro source into ${targetRoot}`)
console.log('Next: pnpm install && pnpm run build')
console.log(`Compatibility baseline: ${COMPATIBLE_DSH_COMMIT}`)
