#!/usr/bin/env node
/** Keyless installer smoke: supply a local DSH checkout and an explicit scratch root. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { externalIntegrationPatches } from './installer-patches.mjs'

const baseline = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.DSH_SOURCE_CHECKOUT
const scratch = process.env.DSH_INSTALLER_TEST_ROOT
assert.ok(source && isAbsolute(source), 'DSH_SOURCE_CHECKOUT must name an absolute local DSH checkout')
assert.ok(scratch && isAbsolute(scratch), 'DSH_INSTALLER_TEST_ROOT must name an absolute disposable scratch directory')
mkdirSync(scratch, { recursive: true })
const runRoot = mkdtempSync(join(scratch, 'voice-installer-'))
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const archive = execFileSync('git', ['-C', source, 'archive', '--format=tar', baseline], { maxBuffer: 256 * 1024 * 1024 })
const objectDirectory = git(source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects')

function fixture(name) {
  const target = join(runRoot, name)
  mkdirSync(target)
  execFileSync('tar', ['-xf', '-', '-C', target], { input: archive })
  git(target, 'init', '--quiet')
  // Borrow objects read-only; the archive and index describe the exact pinned tree.
  writeFileSync(join(target, '.git', 'objects', 'info', 'alternates'), `${objectDirectory}\n`)
  git(target, 'update-ref', 'HEAD', baseline)
  git(target, 'read-tree', baseline)
  assert.equal(git(target, 'status', '--porcelain'), '', 'archive fixture must start clean')
  return target
}

function install(target, ...args) {
  return spawnSync(process.execPath, [join(repository, 'scripts/install-into-dsh.mjs'), target, ...args], {
    encoding: 'utf8', timeout: 30_000,
  })
}

const read = (target, path) => readFileSync(join(target, path), 'utf8')
function treeDigest(root) {
  const hash = createHash('sha256')
  function walk(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (relative === '' && entry.name === '.git') continue
      const path = join(directory, entry.name)
      const name = join(relative, entry.name)
      hash.update(name).update('\0')
      if (entry.isSymbolicLink()) hash.update('symlink\0').update(readlinkSync(path))
      else if (entry.isDirectory()) walk(path, name)
      else hash.update(readFileSync(path))
      hash.update('\0')
    }
  }
  walk(root)
  return hash.digest('hex')
}

function rejectsUnchanged(target, pattern, ...args) {
  const before = treeDigest(target)
  const result = install(target, ...args)
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, pattern)
  assert.equal(treeDigest(target), before, 'rejection must precede target file writes')
}

await test('installs the pinned archive with global voice integrations and only scoped tracked changes', () => {
  const target = fixture('success')
  const result = install(target)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(baseline))
  for (const patch of externalIntegrationPatches) {
    assert.ok(read(target, patch.path).includes(patch.after), `missing integration: ${patch.path}`)
  }
  for (const path of [
    'packages/voice/voice', 'packages/voice/voice-openai-realtime',
    'packages/client/wake-word-local', 'packages/client/ui-voice',
  ]) {
    assert.equal(read(target, `${path}/package.json`), read(repository, `${path}/package.json`))
    assert.equal(read(target, `${path}/src/index.ts`), read(repository, `${path}/src/index.ts`))
  }
  const remotes = JSON.parse(read(target, 'packages/api/remotes/package.json'))
  assert.equal(remotes.dependencies.zod, '^4.4.3')
  assert.equal(remotes.peerDependencies['@deepseek-ai/dsh-voice'], 'workspace:^')
  assert.equal(remotes.devDependencies['@deepseek-ai/dsh-voice'], 'workspace:^')
  const proxy = JSON.parse(read(target, 'packages/host/apiproxy/package.json'))
  assert.equal(proxy.dependencies['@deepseek-ai/dsh-voice'], 'workspace:^')
  const bundle = JSON.parse(read(target, 'packages/bundle/web-app/package.json'))
  for (const name of ['voice', 'voice-openai-realtime', 'client-ui-voice', 'client-wake-word-local']) {
    assert.equal(bundle.dependencies[`@deepseek-ai/dsh-${name}`], 'workspace:^')
  }
  assert.match(read(target, 'packages/bundle/web-app/cordis.patch.yml'), /model: gpt-realtime-2\.1-mini\n/)
  for (const path of ['tsconfig.client.json', 'tsconfig.host.json']) {
    assert.ok(read(target, path).includes('voice'))
  }
  assert.ok(read(target, 'packages/api/remotes/tsconfig.client.json').includes('../../voice/voice'))
  assert.ok(read(target, 'packages/api/remotes/src/client/index.ts').includes('sessionReferencesRemote, voiceRemote,'))
  const expected = new Set([
    'tsconfig.base.json', 'tsconfig.client.json', 'tsconfig.host.json',
    'packages/api/remotes/tsconfig.client.json', 'packages/api/remotes/src/client/index.ts',
    'packages/api/remotes/package.json', 'packages/bundle/web-app/package.json',
    'packages/bundle/web-app/cordis.patch.yml',
    ...externalIntegrationPatches.map(patch => patch.path),
  ])
  assert.deepEqual(new Set(git(target, 'diff', '--name-only').split('\n')), expected)
  git(target, 'diff', '--check')
  // --force permits reviewed dirt, but a second installation is not an upgrade.
  rejectsUnchanged(target, /integration already installed/, '--force')
})

await test('rejects another commit even with --force', () => {
  const target = fixture('unsupported')
  git(target, 'update-ref', 'HEAD', git(source, 'rev-parse', `${baseline}^`))
  rejectsUnchanged(target, /DSH checkout must be at tested commit/, '--force')
})

await test('rejects a dirty pinned target without --force', () => {
  const target = fixture('dirty')
  writeFileSync(join(target, 'installer-local-change.txt'), 'Keep this local change.\n')
  rejectsUnchanged(target, /DSH checkout must be clean/)
  assert.equal(existsSync(join(target, 'packages/voice/voice')), false)
})

await test('preflights a missing late insertion point before copying any package', () => {
  const target = fixture('late-anchor')
  const path = 'packages/client/runtime/tests/workspaces-service.client.spec.ts'
  const last = externalIntegrationPatches.at(-1)
  assert.equal(last.path, path)
  writeFileSync(join(target, path), read(target, path).replace(last.before, last.before.replace('a rejected', 'the rejected')))
  rejectsUnchanged(target, /compatible insertion point not found/, '--force')
  assert.equal(existsSync(join(target, 'packages/voice/voice')), false)
})

await test('preflights ambiguous insertion points before copying any package', () => {
  const target = fixture('ambiguous-anchor')
  const path = 'packages/client/runtime/tests/workspaces-service.client.spec.ts'
  writeFileSync(join(target, path), read(target, path) + externalIntegrationPatches.at(-1).before)
  rejectsUnchanged(target, /insertion point is ambiguous/, '--force')
  assert.equal(existsSync(join(target, 'packages/voice/voice')), false)
})

console.log(`Installer fixtures retained at ${runRoot}`)
