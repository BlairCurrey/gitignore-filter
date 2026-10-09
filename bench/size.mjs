// Measures what each option actually installs: number of packages and total
// size on disk of node_modules, from a clean install of production
// dependencies only. Reproduce with `npm run size`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// Pack this package so it is measured exactly as it would be published.
const tarball = join(root, execFileSync(npm, ['pack', '--silent'], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop())

const scenarios = [
  ['globby', ['globby']],
  ['glob', ['glob']],
  ['fast-glob', ['fast-glob']],
  ['tinyglobby', ['tinyglobby']],
  ['tinyglobby + gitignore-filter', ['tinyglobby', tarball]],
]

function walk(dir) {
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) bytes += walk(full)
    else if (entry.isFile()) bytes += statSync(full).size
  }
  return bytes
}

function countPackages(nodeModules) {
  let count = 0
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      count += countPackages(dir)
      continue
    }
    if (existsSync(join(dir, 'package.json'))) count++
    if (existsSync(join(dir, 'node_modules'))) count += countPackages(join(dir, 'node_modules'))
  }
  return count
}

const rows = []
for (const [label, specs] of scenarios) {
  const dir = mkdtempSync(join(tmpdir(), 'size-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"size-probe","version":"1.0.0","private":true}')
  execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--silent', ...specs], { cwd: dir, stdio: 'ignore' })
  const nm = join(dir, 'node_modules')
  const versions = specs
    .filter((s) => !s.endsWith('.tgz'))
    .map((s) => `${s}@${JSON.parse(execFileSync(npm, ['ls', s, '--json', '--depth=0'], { cwd: dir, encoding: 'utf8' })).dependencies[s].version}`)
  rows.push({ label, versions, packages: countPackages(nm), bytes: walk(nm) })
  rmSync(dir, { recursive: true, force: true })
}
rmSync(tarball, { force: true })

const kb = (b) => `${(b / 1024).toFixed(0)} kB`
console.log('| What you install | Packages | Size on disk |')
console.log('| --- | ---: | ---: |')
for (const r of rows) console.log(`| ${r.label} | ${r.packages} | ${kb(r.bytes)} |`)
console.log('\nVersions:', rows.flatMap((r) => r.versions).join(', '), `\nMeasured ${new Date().toISOString().slice(0, 10)} on Node ${process.version}`)
console.log('\nJSON:', JSON.stringify(rows))
