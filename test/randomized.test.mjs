// Randomized differential testing: generate many random trees and random
// ignore files, and require the package to agree with git on every file.
//
// Runs are reproducible from the seed. To reproduce a failure:
//   FUZZ_SEED=<seed printed in the failure> FUZZ_RUNS=1 npm run test:only
// To run more cases locally: FUZZ_RUNS=2000 npm run test:only
import { describe, it } from 'node:test'
import { assertMatchesGit, makeTree, rng } from './helpers.mjs'

const RUNS = Number(process.env.FUZZ_RUNS ?? 300)
const BASE_SEED = Number(process.env.FUZZ_SEED ?? 20261004)

const DIR_NAMES = ['a', 'b', 'build', 'logs', 'src', 'node_modules', 'Docs']
const FILE_NAMES = ['x.js', 'y.log', 'keep.log', 'Z.txt', '.env', 'b', 'temp', 'readme.md', 'ax.js', 'bx.js']
const ATOMS = [...DIR_NAMES, ...FILE_NAMES, '*.js', '*.log', '*.txt', '*.md', '*', '?.js', '[ab]x.js', '[!a]x.js', '.*', 'Z.*']
const DECORATED = (r, atom) => {
  switch (r.int(9)) {
    case 0: return `/${atom}`
    case 1: return `${atom}/`
    case 2: return `**/${atom}`
    case 3: return `${atom}/**`
    case 4: return `${r.pick(DIR_NAMES)}/${atom}`
    case 5: return `${r.pick(DIR_NAMES)}/**/${atom}`
    case 6: return `${r.pick(DIR_NAMES)}/*`
    default: return atom
  }
}

function randomPattern(r) {
  let pattern = DECORATED(r, r.pick(ATOMS))
  if (r.chance(0.3)) pattern = `!${pattern}`
  if (r.chance(0.05)) pattern = `# ${pattern}`
  if (r.chance(0.05)) pattern = `${pattern}   `
  return pattern
}

function randomTree(seed) {
  const r = rng(seed)
  const dirs = new Set([''])
  const files = new Set()
  const tree = {}

  const conflicts = (path) => {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join('/'))) return true
    return dirs.has(path) || files.has(path)
  }

  const dirCount = 2 + r.int(6)
  for (let i = 0; i < dirCount; i++) {
    const parent = r.pick([...dirs])
    const dir = parent === '' ? r.pick(DIR_NAMES) : `${parent}/${r.pick(DIR_NAMES)}`
    if (dir.split('/').length > 4 || conflicts(dir)) continue
    // On case-insensitive file systems, names differing only by case collide.
    if ([...dirs].some((d) => d !== dir && d.toLowerCase() === dir.toLowerCase())) continue
    dirs.add(dir)
  }

  const fileCount = 4 + r.int(20)
  for (let i = 0; i < fileCount; i++) {
    const dir = r.pick([...dirs])
    const path = dir === '' ? r.pick(FILE_NAMES) : `${dir}/${r.pick(FILE_NAMES)}`
    if (conflicts(path)) continue
    if ([...files, ...dirs].some((p) => p !== path && p.toLowerCase() === path.toLowerCase())) continue
    files.add(path)
    tree[path] = ''
  }

  // Every directory needs at least one file to exist for git.
  for (const dir of dirs) {
    if (dir === '' || [...files].some((f) => f.startsWith(`${dir}/`))) continue
    const path = `${dir}/x.js`
    if (!conflicts(path)) {
      files.add(path)
      tree[path] = ''
    }
  }

  const ignoreFileCount = 1 + r.int(4)
  for (let i = 0; i < ignoreFileCount; i++) {
    const dir = i === 0 ? '' : r.pick([...dirs])
    const path = dir === '' ? '.gitignore' : `${dir}/.gitignore`
    if (tree[path] === undefined && conflicts(path)) continue
    const lines = Array.from({ length: 1 + r.int(6) }, () => randomPattern(r))
    tree[path] = `${tree[path] ?? ''}${lines.join('\n')}\n`
  }
  return tree
}

describe(`randomized comparison against git (${RUNS} runs, base seed ${BASE_SEED})`, () => {
  it('agrees with git on every generated tree', () => {
    for (let i = 0; i < RUNS; i++) {
      const seed = BASE_SEED + i
      const tree = randomTree(seed)
      try {
        assertMatchesGit(makeTree(tree), { label: `seed ${seed}:` })
      } catch (error) {
        error.message += `\n\nReproduce with FUZZ_SEED=${seed} FUZZ_RUNS=1\nTree:\n${JSON.stringify(tree, null, 2)}`
        throw error
      }
    }
  })
})
