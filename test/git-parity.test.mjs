// Hand-written scenarios, each checked file-by-file against git.
import { describe, it } from 'node:test'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createGitignoreFilter } from '../dist/index.mjs'
import {
  assertMatchesGit,
  git,
  globalConfigPath,
  isWindows,
  listFiles,
  makeTree,
  resetGlobalConfig,
  writeFiles,
  xdgIgnorePath,
} from './helpers.mjs'

const scenarios = {
  'basic globs and negation': {
    '.gitignore': '*.log\n!keep.log\n',
    'a.log': '',
    'keep.log': '',
    'src/b.log': '',
    'src/keep.log': '',
    'src/c.js': '',
  },
  'directory-only patterns': {
    '.gitignore': 'build/\n',
    'build/out.js': '',
    'src/build/out.js': '',
    'docs/build': 'a file named build, not a directory',
  },
  'anchored vs unanchored': {
    '.gitignore': '/root-only.txt\nanywhere.txt\n/dist\n',
    'root-only.txt': '',
    'sub/root-only.txt': '',
    'anywhere.txt': '',
    'sub/deep/anywhere.txt': '',
    'dist/a.js': '',
    'sub/dist/a.js': '',
  },
  'nested .gitignore is scoped to its directory': {
    '.gitignore': '',
    'src/.gitignore': '*.tmp\n/generated\nlocal/\n',
    'a.tmp': '',
    'src/a.tmp': '',
    'src/x/b.tmp': '',
    'src/generated/g.js': '',
    'src/x/generated/g.js': '',
    'generated/g.js': '',
    'src/local/l.js': '',
    'local/l.js': '',
  },
  'deeper files override shallower ones': {
    '.gitignore': '*.log\n',
    'a.log': '',
    'pkg/.gitignore': '!*.log\n',
    'pkg/b.log': '',
    'pkg/deep/c.log': '',
    'other/d.log': '',
  },
  'cannot re-include inside an ignored directory': {
    '.gitignore': 'logs/\n!logs/keep.log\ncache/*\n!cache/keep.txt\n',
    'logs/keep.log': '',
    'logs/a.log': '',
    'cache/keep.txt': '',
    'cache/a.txt': '',
  },
  'deeper file un-ignores a directory ignored at the root': {
    '.gitignore': 'vendor/\n',
    'vendor/v.js': '',
    'a/.gitignore': '!vendor/\n',
    'a/vendor/v.js': '',
    'b/vendor/v.js': '',
  },
  'double-star forms': {
    '.gitignore': 'a/**/b.js\n**/temp\ndocs/**\n!docs/keep.md\n',
    'a/b.js': '',
    'a/x/y/b.js': '',
    'z/a/b.js': '',
    'x/temp/t.txt': '',
    'temp': 'file named temp',
    'docs/one.md': '',
    'docs/keep.md': '',
  },
  'character classes and single-char wildcards': {
    '.gitignore': '[ab].txt\n?.md\n[!c]x.js\n',
    'a.txt': '',
    'b.txt': '',
    'c.txt': '',
    'x.md': '',
    'xy.md': '',
    'ax.js': '',
    'cx.js': '',
  },
  'comments, blank lines, CRLF and BOM': {
    '.gitignore': '\uFEFF# comment\r\n\r\n*.bak\r\n   \r\n#not-a-pattern.txt\r\n',
    'a.bak': '',
    '#not-a-pattern.txt': '',
    'b.txt': '',
  },
  'escaped hash and bang': {
    '.gitignore': '\\#hash.txt\n\\!bang.txt\n',
    '#hash.txt': '',
    '!bang.txt': '',
    'hash.txt': '',
  },
  'ignoring the .gitignore itself and everything': {
    '.gitignore': '*\n!src/\n!src/**\n',
    'top.js': '',
    'src/a.js': '',
    'src/deep/b.js': '',
  },
  'ignored directory contents never consult inner ignore files': {
    '.gitignore': 'out/\n',
    'out/.gitignore': '!*\n',
    'out/a.js': '',
  },
}

if (!isWindows) {
  // These names are not valid on Windows.
  Object.assign(scenarios, {
    'directory names with glob characters are escaped when scoping': {
      '[x]/.gitignore': '*.log\n',
      '[x]/a.log': '',
      'x/a.log': '',
      'a*b/.gitignore': '/c.txt\n',
      'a*b/c.txt': '',
      'aZb/c.txt': '',
    },
    'escaped trailing space': {
      '.gitignore': 'space\\ \ntrimmed   \n',
      'space ': '',
      'space': '',
      'trimmed': '',
    },
  })
}

describe('matches git on hand-written scenarios', () => {
  for (const [name, files] of Object.entries(scenarios)) {
    it(name, () => assertMatchesGit(makeTree(files), { label: name }))
  }
})

describe('git ignore sources beyond .gitignore', () => {
  it('.git/info/exclude', () => {
    const root = makeTree({ 'secret.txt': '', 'a.js': '', 'sub/secret.txt': '' })
    writeFiles(root, { '.git/info/exclude': 'secret.txt\n' })
    assertMatchesGit(root)
  })

  it('.gitignore overrides .git/info/exclude', () => {
    const root = makeTree({ '.gitignore': '!keep.txt\n', 'keep.txt': '', 'drop.txt': '' })
    writeFiles(root, { '.git/info/exclude': '*.txt\n' })
    assertMatchesGit(root)
  })

  it('global excludes file from core.excludesFile', () => {
    const root = makeTree({ '.DS_Store': '', 'a.js': '', 'sub/.DS_Store': '' })
    writeFiles(root, { '../global-ignore': '.DS_Store\n' })
    git(root, ['config', '--file', globalConfigPath, 'core.excludesFile', join(root, '..', 'global-ignore')])
    try {
      assertMatchesGit(root)
    } finally {
      resetGlobalConfig()
    }
  })

  it('default global excludes file ($XDG_CONFIG_HOME/git/ignore)', () => {
    const root = makeTree({ 'thumbs.db': '', 'a.js': '' })
    writeFileSync(xdgIgnorePath, 'thumbs.db\n')
    try {
      assertMatchesGit(root)
    } finally {
      resetGlobalConfig()
    }
  })

  it('repository config overrides the global core.excludesFile', () => {
    const root = makeTree({ 'a.one': '', 'a.two': '' })
    writeFiles(root, { '../one': '*.one\n', '../two': '*.two\n' })
    git(root, ['config', '--file', globalConfigPath, 'core.excludesFile', join(root, '..', 'one')])
    git(root, ['config', 'core.excludesFile', join(root, '..', 'two')])
    try {
      assertMatchesGit(root)
    } finally {
      resetGlobalConfig()
    }
  })

  it('globalGitignore: false skips the global excludes file', () => {
    const root = makeTree({ 'thumbs.db': '', 'a.js': '' })
    writeFileSync(xdgIgnorePath, 'thumbs.db\n')
    try {
      assert.equal(createGitignoreFilter({ cwd: root }).isIgnored('thumbs.db'), true)
      assert.equal(createGitignoreFilter({ cwd: root, globalGitignore: false }).isIgnored('thumbs.db'), false)
    } finally {
      resetGlobalConfig()
    }
  })

  it('core.ignorecase from the repository config', () => {
    const root = makeTree({ '.gitignore': '*.LOG\nBuild/\n', 'a.log': '', 'b.Log': '', 'build/x.js': '' })
    git(root, ['config', 'core.ignorecase', 'true'])
    assertMatchesGit(root, { label: 'ignorecase=true' })
    git(root, ['config', 'core.ignorecase', 'false'])
    assertMatchesGit(root, { label: 'ignorecase=false' })
  })
})

describe('repository layout', () => {
  it('nested repositories keep their own rules', () => {
    const root = makeTree({
      '.gitignore': '*.log\nignored-repo/\n',
      'a.log': '',
      'inner/.gitignore': '*.tmp\n',
      'inner/b.log': '',
      'inner/c.tmp': '',
      'inner/d.js': '',
      'ignored-repo/e.js': '',
    })
    git(join(root, 'inner'), ['init', '-q'])
    git(join(root, 'ignored-repo'), ['init', '-q'])
    const filter = createGitignoreFilter({ cwd: root })

    // The outer repository: git lists the nested repos as directories.
    assert.equal(filter.isIgnored('a.log'), true)
    assert.equal(filter.isIgnored('ignored-repo', true), true)
    assert.equal(filter.isIgnored('ignored-repo/e.js'), true, 'outer repo ignores the nested repo directory')
    assert.equal(filter.isIgnored('inner', true), false)

    // Inside the nested repository only its own rules apply, as git sees it.
    const inner = join(root, 'inner')
    const innerIgnored = new Set(
      git(inner, ['ls-files', '-z', '-o', '-i', '--exclude-standard']).split('\0').filter(Boolean),
    )
    for (const file of listFiles(inner)) {
      assert.equal(filter.isIgnored(join('inner', file)), innerIgnored.has(file), `inner/${file}`)
    }
    assert.equal(filter.isIgnored('inner/b.log'), false, "outer *.log doesn't reach into the nested repo")
  })

  it('linked worktrees read info/exclude from the shared .git directory', () => {
    const main = makeTree({ 'a.js': '' })
    git(main, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    writeFiles(main, { '.git/info/exclude': 'secret.txt\n' })
    const wt = `${main}-wt`
    git(main, ['worktree', 'add', '-q', wt])
    try {
      writeFiles(wt, { 'secret.txt': '', 'b.js': '', '.gitignore': '*.tmp\n', 'c.tmp': '' })
      assertMatchesGit(wt)
    } finally {
      git(main, ['worktree', 'remove', '--force', wt])
    }
  })

  it('works without a .git directory (e.g. a Docker build context)', () => {
    const files = {
      '.gitignore': 'node_modules/\n*.log\n',
      'node_modules/x/i.js': '',
      'a.log': '',
      'src/.gitignore': '/gen\n',
      'src/gen/g.js': '',
      'src/a.js': '',
    }
    const plain = makeTree(files, { init: false })
    const filter = createGitignoreFilter({ cwd: plain })
    const ours = new Map(listFiles(plain).map((f) => [f, filter.isIgnored(f)]))

    // Same tree with git initialised: git's answers must equal ours.
    const withGit = makeTree(files)
    const ignored = new Set(git(withGit, ['ls-files', '-z', '-o', '-i', '--exclude-standard']).split('\0').filter(Boolean))
    for (const [file, value] of ours) assert.equal(value, ignored.has(file), file)
  })
})

describe('ignoreFiles: other gitignore-style files', () => {
  it('scopes .prettierignore files exactly like git scopes .gitignore', () => {
    const files = {
      '.prettierignore': '*.min.js\n/vendor\n',
      'a.min.js': '',
      'a.js': '',
      'vendor/v.js': '',
      'pkg/.prettierignore': '!keep.min.js\n',
      'pkg/keep.min.js': '',
      'pkg/drop.min.js': '',
      'pkg/vendor/v.js': '',
    }
    const root = makeTree(files, { init: false })
    const filter = createGitignoreFilter({ cwd: root, gitignore: false, ignoreFiles: '.prettierignore' })
    const ours = new Map(listFiles(root).map((f) => [f, filter.isIgnored(f)]))

    // Reference: the same tree with each .prettierignore renamed to .gitignore.
    const twin = makeTree(files, { init: false })
    renameSync(join(twin, '.prettierignore'), join(twin, '.gitignore'))
    renameSync(join(twin, 'pkg/.prettierignore'), join(twin, 'pkg/.gitignore'))
    git(twin, ['init', '-q'])
    const ignored = new Set(git(twin, ['ls-files', '-z', '-o', '-i', '--exclude-standard']).split('\0').filter(Boolean))
    for (const [file, value] of ours) {
      const twinName = file.replace(/\.prettierignore$/, '.gitignore')
      assert.equal(value, ignored.has(twinName), file)
    }
  })

  it('combines .gitignore and extra files, extra files layered on top', () => {
    const root = makeTree({
      '.gitignore': '*.log\n',
      '.prettierignore': '!keep.log\n*.md\n',
      'a.log': '',
      'keep.log': '',
      'README.md': '',
      'a.js': '',
    })
    const f = createGitignoreFilter({ cwd: root, ignoreFiles: ['.prettierignore'] })
    assert.equal(f.isIgnored('a.log'), true)
    assert.equal(f.isIgnored('keep.log'), false)
    assert.equal(f.isIgnored('README.md'), true)
    assert.equal(f.isIgnored('a.js'), false)
  })
})
