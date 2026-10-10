// Speed benchmark on a synthetic monorepo, plus a correctness check of each
// approach against `git ls-files`. Reproduce with `pnpm bench`.
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { globby } from 'globby'
import { glob as tinyGlob, escapePath } from 'tinyglobby'
import { glob as gitignoreGlob } from '../dist/tinyglobby.mjs'

const RUNS = Number(process.env.BENCH_RUNS ?? 7)
const root = mkdtempSync(join(tmpdir(), 'gitignore-filter-bench-'))

function file(path, content = '') {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

// --- Build the fixture -------------------------------------------------------
file('.gitignore', 'node_modules/\ndist/\n*.log\n!keep.log\n.cache/\n')
for (let p = 0; p < 50; p++) {
  const pkg = `packages/pkg${p}`
  file(`${pkg}/.gitignore`, '*.tmp\n/coverage\n')
  file(`${pkg}/package.json`, '{}')
  for (let d = 0; d < 4; d++) for (let f = 0; f < 25; f++) file(`${pkg}/src/dir${d}/file${f}.ts`)
  for (let f = 0; f < 20; f++) file(`${pkg}/dist/out${f}.js`)
  for (let f = 0; f < 10; f++) file(`${pkg}/coverage/c${f}.json`)
  file(`${pkg}/scratch.tmp`)
  file(`${pkg}/debug.log`)
  file(`${pkg}/keep.log`)
}
for (let m = 0; m < 300; m++) for (let d = 0; d < 3; d++) for (let f = 0; f < 20; f++) file(`node_modules/mod${m}/lib${d}/f${f}.js`)
for (let f = 0; f < 200; f++) file(`.cache/c${f}`)
execFileSync('git', ['init', '-q'], { cwd: root })

const truth = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0').filter(Boolean).sort()
const totalFiles = execFileSync('git', ['ls-files', '-z', '--others'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0').filter(Boolean).length

// tinyglobby's documented workaround (superchupu.dev/tinyglobby/migration#gitignore)
async function tinyglobbyGitWorkaround(patterns, options) {
  const { cwd, ...rest } = options
  const gitIgnored = execSync('git ls-files --others --ignored --exclude-standard --directory', {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28,
  }).split('\n').filter(Boolean).map((p) => escapePath(p))
  return tinyGlob(patterns, { ...rest, cwd, ignore: [...(rest.ignore || []), ...gitIgnored] })
}

const contenders = [
  ['tinyglobby, no gitignore support (baseline)', () => tinyGlob('**/*', { cwd: root, dot: true, ignore: ['.git/**'] })],
  ['globby { gitignore: true }', () => globby('**/*', { cwd: root, dot: true, gitignore: true, ignore: ['.git/**'] })],
  ['tinyglobby + documented `git ls-files` workaround', () => tinyglobbyGitWorkaround('**/*', { cwd: root, dot: true, ignore: ['.git/**'] })],
  ['tinyglobby + gitignore-filter', () => gitignoreGlob('**/*', { cwd: root, dot: true })],
]

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const rows = []
for (const [label, run] of contenders) {
  await run() // warm up
  const times = []
  let result
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    result = await run()
    times.push(performance.now() - t)
  }
  const sorted = [...result].sort()
  const matches = sorted.length === truth.length && sorted.every((p, i) => p === truth[i])
  rows.push({ label, ms: median(times), count: result.length, matches })
}

console.log(`Fixture: ${totalFiles.toLocaleString()} files, ${truth.length.toLocaleString()} not ignored by git. Median of ${RUNS} runs.\n`)
console.log('| Approach | Median time | Files returned | Matches git |')
console.log('| --- | ---: | ---: | :---: |')
for (const r of rows) console.log(`| ${r.label} | ${r.ms.toFixed(0)} ms | ${r.count.toLocaleString()} | ${r.matches ? 'yes' : 'no'} |`)
console.log(`\nNode ${process.version}, ${process.platform}`)
rmSync(root, { recursive: true, force: true })
