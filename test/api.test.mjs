// API behavior: options, path forms, and the integrations.
import { describe, it } from 'node:test'
import { createRequire } from 'node:module'
import { globSync as fsGlobSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { fdir } from 'fdir'
import { glob as tinyGlob, globSync as tinyGlobSync } from 'tinyglobby'
import { createGitignoreFilter, rebasePatterns } from '../dist/index.mjs'
import { glob, globSync } from '../dist/tinyglobby.mjs'
import { isWindows, makeTree } from './helpers.mjs'

const fixture = () =>
  makeTree({
    '.gitignore': 'node_modules/\ndist/\n*.log\nbuild/\n',
    'node_modules/pkg/index.js': '',
    'dist/out.js': '',
    'src/index.js': '',
    'src/debug.log': '',
    'src/.gitignore': '/generated\n',
    'src/generated/g.js': '',
    'docs/build': 'a file called build',
    'README.md': '',
  })

const visible = ['.gitignore', 'README.md', 'docs/build', 'src/.gitignore', 'src/index.js']

describe('isIgnored', () => {
  it('accepts relative, absolute and file URL paths', () => {
    const root = fixture()
    const f = createGitignoreFilter({ cwd: root })
    assert.equal(f.isIgnored('dist/out.js'), true)
    assert.equal(f.isIgnored(join(root, 'dist/out.js')), true)
    assert.equal(f.isIgnored(pathToFileURL(join(root, 'dist/out.js'))), true)
    assert.equal(f.isIgnored('src/index.js'), false)
  })

  it('accepts cwd as a file URL', () => {
    const root = fixture()
    assert.equal(createGitignoreFilter({ cwd: pathToFileURL(root) }).isIgnored('dist/out.js'), true)
  })

  it('resolves relative paths from a cwd below the repository root', () => {
    const root = fixture()
    const f = createGitignoreFilter({ cwd: join(root, 'src') })
    assert.equal(f.isIgnored('generated/g.js'), true)
    assert.equal(f.isIgnored('debug.log'), true, 'root .gitignore still applies')
    assert.equal(f.isIgnored('index.js'), false)
    assert.equal(f.isIgnored('../dist/out.js'), true)
  })

  it('handles directory-only patterns with and without hints', () => {
    const root = fixture()
    const f = createGitignoreFilter({ cwd: root })
    assert.equal(f.isIgnored('docs/build'), false, 'checks the disk: it is a file')
    assert.equal(f.isIgnored('docs/build', false), false)
    assert.equal(f.isIgnored('docs/build', true), true, 'hint wins over the disk')
    assert.equal(f.isIgnored('docs/build/'), true, 'trailing slash means directory')
    assert.equal(f.isIgnored('dist'), true, 'existing directory')
    assert.equal(f.isIgnored('nope/build'), false, 'missing path is treated as a file')
  })

  it('treats a symlink to a directory as a file, like git', { skip: isWindows }, () => {
    const root = fixture()
    symlinkSync(join(root, 'src'), join(root, 'build'))
    assert.equal(createGitignoreFilter({ cwd: root }).isIgnored('build'), false)
  })

  it('never ignores paths outside the repository and cwd', () => {
    const root = fixture()
    const f = createGitignoreFilter({ cwd: root })
    assert.equal(f.isIgnored(join(root, '..', 'elsewhere.log')), false)
    assert.equal(f.isIgnored(root), false)
  })

  it('treats .git as ignored', () => {
    const root = fixture()
    assert.equal(createGitignoreFilter({ cwd: root }).isIgnored('.git/config'), true)
  })

  it('ignores nothing when gitignore is off and there are no ignore files', () => {
    const root = fixture()
    assert.equal(createGitignoreFilter({ cwd: root, gitignore: false }).isIgnored('dist/out.js'), false)
  })

  it('respects an explicit ignoreCase option', () => {
    const root = makeTree({ '.gitignore': '*.LOG\n', 'a.log': '' })
    assert.equal(createGitignoreFilter({ cwd: root, ignoreCase: false }).isIgnored('a.log'), false)
    assert.equal(createGitignoreFilter({ cwd: root, ignoreCase: true }).isIgnored('a.log'), true)
  })
})

describe('filter', () => {
  it('keeps order and drops ignored paths', () => {
    const root = fixture()
    const f = createGitignoreFilter({ cwd: root })
    assert.deepEqual(f.filter(['src/index.js', 'dist/out.js', 'README.md', 'dist/']), ['src/index.js', 'README.md'])
  })
})

describe('ignoreFiles option validation', () => {
  it('accepts names and globby-style **/ names', () => {
    assert.doesNotThrow(() => createGitignoreFilter({ ignoreFiles: '.prettierignore' }))
    assert.doesNotThrow(() => createGitignoreFilter({ ignoreFiles: ['**/.eslintignore'] }))
  })
  it('rejects paths and globs with a helpful message', () => {
    assert.throws(() => createGitignoreFilter({ ignoreFiles: 'config/.prettierignore' }), /file names/)
    assert.throws(() => createGitignoreFilter({ ignoreFiles: '*.ignore' }), /file names/)
  })
})

describe('tinyglobby helper (gitignore-filter/tinyglobby)', () => {
  it('glob and globSync, patterns and options forms', async () => {
    const root = fixture()
    assert.deepEqual((await glob('**/*', { cwd: root, dot: true })).sort(), visible)
    assert.deepEqual(globSync('**/*', { cwd: root, dot: true }).sort(), visible)
    assert.deepEqual(globSync({ patterns: ['**/*'], cwd: root, dot: true }).sort(), visible)
    assert.deepEqual((await glob({ patterns: ['src/**'], cwd: root })).sort(), ['src/index.js'])
  })

  it('gitignore: false behaves exactly like tinyglobby', async () => {
    const root = fixture()
    const opts = { cwd: root, dot: true, ignore: ['.git/**'] }
    assert.deepEqual((await glob('**/*', { ...opts, gitignore: false })).sort(), (await tinyGlob('**/*', opts)).sort())
  })

  it('combines with tinyglobby ignore patterns and other options', () => {
    const root = fixture()
    assert.deepEqual(globSync('**/*.js', { cwd: root, ignore: ['src/**'] }), [])
    assert.deepEqual(globSync('**/*', { cwd: root, absolute: true }).sort(), [join(root, 'README.md'), join(root, 'docs/build'), join(root, 'src/index.js')].map((p) => p.split('\\').join('/')).sort())
    assert.deepEqual(globSync('src', { cwd: root, onlyDirectories: true }), ['src/'])
  })

  it('prunes ignored directories instead of crawling them', () => {
    const root = fixture()
    const read = []
    const f = createGitignoreFilter({ cwd: root })
    const fs = f.createFs({
      readdirSync: (path, opts) => {
        read.push(String(path).split('\\').join('/'))
        return createRequire(import.meta.url)('node:fs').readdirSync(path, opts)
      },
    })
    tinyGlobSync('**/*', { cwd: root, fs })
    assert.ok(!read.some((p) => p.includes('node_modules') || p.endsWith('/dist') || p.includes('/dist/')), `crawled: ${read.join(', ')}`)
  })

  it('accepts ignoreFiles', () => {
    const root = makeTree({ '.prettierignore': '*.md\n', 'a.md': '', 'a.js': '' })
    assert.deepEqual(globSync('*', { cwd: root, gitignore: false, ignoreFiles: '.prettierignore', dot: true }).sort(), ['.prettierignore', 'a.js'])
  })
})

describe('fdir integration', () => {
  it('works through createFs', () => {
    const root = fixture()
    const files = new fdir({ fs: createGitignoreFilter({ cwd: root }).createFs() })
      .withRelativePaths()
      .exclude((name) => name === '.git')
      .crawl(root)
      .sync()
      .map((p) => p.split('\\').join('/'))
      .sort()
    assert.deepEqual(files, visible)
  })

  it('works through fdirExclude', () => {
    const root = fixture()
    const f = createGitignoreFilter({ cwd: root })
    const dirs = new fdir().withRelativePaths().onlyDirs().exclude(f.fdirExclude).crawl(root).sync()
    assert.ok(!dirs.some((d) => d.includes('node_modules') || d.startsWith('dist')), dirs.join(', '))
  })
})

describe('Node fs.glob integration', () => {
  it('fsGlobExclude with withFileTypes', { skip: typeof fsGlobSync !== 'function' }, () => {
    const root = fixture()
    const f = createGitignoreFilter({ cwd: root })
    const rel = (d) => join(d.parentPath, d.name).slice(root.length + 1).split('\\').join('/')
    const raw = fsGlobSync('**/*', { cwd: root, withFileTypes: true, exclude: f.fsGlobExclude })

    // Ignored directories are pruned: nothing from inside them is returned.
    assert.ok(!raw.some((d) => /^(node_modules|dist)(\/|$)/.test(rel(d))), raw.map(rel).join(', '))

    // Node's fs.glob can still return some files that exclude rejected
    // (nodejs/node#63049), so the documented pattern filters results too.
    const files = raw.filter((d) => d.isFile() && !f.fsGlobExclude(d)).map(rel).sort()
    // fs.glob's `*` does not match dotfiles.
    assert.deepEqual(files, visible.filter((p) => !p.split('/').some((s) => s.startsWith('.'))))
  })

  it('fsGlobExclude explains itself when given strings', () => {
    const f = createGitignoreFilter()
    assert.throws(() => f.fsGlobExclude('a'), /withFileTypes/)
  })
})

describe('CommonJS entry points', () => {
  it('can be required', () => {
    const require = createRequire(import.meta.url)
    const cjs = require('../dist/index.cjs')
    assert.equal(typeof cjs.createGitignoreFilter, 'function')
    const tg = require('../dist/tinyglobby.cjs')
    assert.equal(typeof tg.glob, 'function')
    assert.equal(typeof tg.globSync, 'function')
  })
})

describe('rebasePatterns', () => {
  it('rebases rules from a subdirectory onto the root', () => {
    assert.deepEqual(rebasePatterns('*.log\n/build\nlib/\na/b\n!keep.log\n# c\n\n', 'src'), [
      'src/**/*.log',
      'src/build',
      'src/**/lib/',
      'src/a/b',
      '!src/**/keep.log',
    ])
  })
  it('leaves root rules untouched apart from comments and blanks', () => {
    assert.deepEqual(rebasePatterns('*.log\n# c\n\n/x\n', ''), ['*.log', '/x'])
  })
  it('escapes glob characters in directory names', () => {
    assert.deepEqual(rebasePatterns('*.js', 'a[1]/b*c'), ['a\\[1\\]/b\\*c/**/*.js'])
  })
})
