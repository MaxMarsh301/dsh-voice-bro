#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const requiredPackages = new Map([
  ['packages/voice/voice', '@deepseek-ai/dsh-voice'],
  ['packages/voice/voice-openai-realtime', '@deepseek-ai/dsh-voice-openai-realtime'],
  ['packages/client/ui-voice', '@deepseek-ai/dsh-client-ui-voice'],
  ['packages/client/wake-word-local', '@deepseek-ai/dsh-client-wake-word-local'],
])
const forbiddenNames = new Set(['node_modules', 'lib', '.env', '.env.local'])
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /OPENAI_API_KEY\s*=\s*[^\s"']+/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /gh[oprsu]_[A-Za-z0-9]{20,}/,
  /(?:^|["'\s])\/home\/[A-Za-z0-9._-]+\//m,
  /(?:^|["'\s])\/Users\/[A-Za-z0-9._-]+\//m,
  /(?:^|["'\s])[A-Za-z]:\\Users\\[^\\\s]+\\/m,
]

async function walk(directory) {
  const paths = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    if (forbiddenNames.has(entry.name)) throw new Error(`forbidden repository path: ${join(directory, entry.name)}`)
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await walk(path))
    else paths.push(path)
  }
  return paths
}

for (const [directory, expectedName] of requiredPackages) {
  const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'))
  if (manifest.name !== expectedName) throw new Error(`${directory}: expected package ${expectedName}`)
  if (manifest.license !== 'MIT') throw new Error(`${directory}: expected MIT license`)
  if (!String(manifest.repository?.url).includes('MaxMarsh301/dsh-voice-bro')) {
    throw new Error(`${directory}: repository URL does not point to dsh-voice-bro`)
  }
}

for (const file of await walk(root)) {
  const bytes = await readFile(file)
  if (bytes.includes(0)) continue
  const text = bytes.toString('utf8')
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) throw new Error(`possible secret in ${file}: ${pattern}`)
  }
}

const readme = await readFile(join(root, 'README.md'), 'utf8')
for (const keyword of ['DeepSeek Harness', 'OpenAI Realtime', 'WebRTC', 'wake word', 'БРО', 'voice mode']) {
  if (!readme.toLowerCase().includes(keyword.toLowerCase())) throw new Error(`README is missing searchable term: ${keyword}`)
}

console.log(`Repository verification passed (${requiredPackages.size} packages).`)
