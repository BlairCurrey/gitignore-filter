// Shared helpers for the test suite. The reference for every "is this
// ignored?" answer is git itself, via `git ls-files`, so the tests check the
// package against git's real behavior rather than against our reading of the
// gitignore documentation.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import assert from 'node:assert/strict'
import { createGitignoreFilter } from '../dist/index.mjs'
import { globSync } from '../dist/tinyglobby.mjs'

export const isWindows = process.platform === 'win32'

// Isolate git (and the package, which reads the same environment variables)
// from the machine's own git configuration, so results are reproducible.
const sandbox = mkdtempSync(join(tmpdir(), 'gitignore-filter-env-'))
mkdirSync(join(sandbox, 'xdg', 'git'), { recursive: true })
writeFileSync(join(sandbox, 'gitconfig'), '')
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox
process.env.XDG_CONFIG_HOME = join(sandbox, 'xdg')
process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig')
process.env.GIT_CONFIG_NOSYSTEM = '1'
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete process.env[key]

export const sandboxDir = sandbox
export const globalConfigPath = join(sandbox, 'gitconfig')
export const xdgIgnorePath = join(sandbox, 'xdg', 'git', 'ignore')

export function resetGlobalConfig() {
  writeFileSync(globalConfigPath, '')
  rmSync(xdgIgnorePath, { force: true })
}

const tempRoots = []
process.on('exit', () => {
  for (const dir of [...tempRoots, sandbox]) rmSync(dir, { recursive: true, force: true })
})

export function git(cwd, args, input) {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stderr}`)
  }
  return result.stdout
}

/** Create a directory tree from `{ 'path/to/file': 'contents' }`. Optionally `git init` it. */
export function makeTree(files, { init = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gitignore-filter-'))
  tempRoots.push(root)
  writeFiles(root, files)
  if (init) git(root, ['init', '-q'])
  return root
}

export function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

/** Every file under `root` (posix, relative), skipping `.git` directories. */
export function listFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(root, full, out)
    else out.push(relative(root, full).split(sep).join('/'))
  }
  return out.sort()
}

/** Every directory under `root` (posix, relative), skipping `.git`. */
export function listDirs(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || !entry.isDirectory()) continue
    const full = join(dir, entry.name)
    out.push(relative(root, full).split(sep).join('/'))
    listDirs(root, full, out)
  }
  return out.sort()
}

function nulList(text) {
  return text.split('\0').filter(Boolean)
}

/** Files git reports as ignored (untracked + ignored, fully expanded). */
export function gitIgnored(root) {
  return new Set(nulList(git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])))
}

/** Files git reports as untracked and not ignored. */
export function gitVisible(root) {
  return new Set(nulList(git(root, ['ls-files', '-z', '--others', '--exclude-standard'])))
}

/**
 * Assert that the package agrees with git about every file in the tree, that
 * the tinyglobby helper returns exactly git's visible files, and that every
 * directory the package calls ignored really has all its files ignored by git
 * (which is what makes pruning safe).
 */
export function assertMatchesGit(root, { label = '', filterOptions = {} } = {}) {
  const ignored = gitIgnored(root)
  const visible = gitVisible(root)
  const filter = createGitignoreFilter({ cwd: root, ...filterOptions })
  const files = listFiles(root)

  const mismatches = []
  for (const file of files) {
    const expected = ignored.has(file)
    if (!expected && !visible.has(file)) continue // tracked files: git lists neither
    const actual = filter.isIgnored(file)
    if (actual !== expected) mismatches.push(`${file}: git=${expected ? 'ignored' : 'kept'} ours=${actual ? 'ignored' : 'kept'}`)
  }
  assert.deepEqual(mismatches, [], `${label} file mismatches vs git`)

  for (const dir of listDirs(root)) {
    if (!filter.isIgnored(dir, true)) continue
    const leaked = files.filter((f) => f.startsWith(`${dir}/`) && !ignored.has(f))
    assert.deepEqual(leaked, [], `${label} directory "${dir}" treated as ignored but git keeps files inside`)
  }

  const globbed = globSync('**/*', { cwd: root, dot: true, ignore: ['**/.git/**'] }).sort()
  assert.deepEqual(globbed, [...visible].sort(), `${label} tinyglobby helper result differs from git's visible files`)
}

/** Deterministic PRNG (mulberry32) so randomized tests are reproducible from a seed. */
export function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  }
}
