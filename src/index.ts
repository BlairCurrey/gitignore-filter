import * as nodeFs from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ignore, { type Ignore } from 'ignore'
import { isRepoRoot, readRepoSettings, resolveGitDirs } from './git.js'
import { rebasePatterns } from './patterns.js'

export { rebasePatterns } from './patterns.js'

export interface GitignoreFilterOptions {
  /**
   * Directory that relative paths are resolved from, and the starting point
   * for finding the repository. Defaults to `process.cwd()`.
   */
  cwd?: string | URL
  /**
   * Respect `.gitignore` files, `.git/info/exclude` and (see
   * `globalGitignore`) the global excludes file. Defaults to `true`.
   */
  gitignore?: boolean
  /**
   * Extra ignore files that use gitignore syntax, such as `.prettierignore`
   * or `.eslintignore`. They are found and scoped exactly like `.gitignore`
   * files. Give file names, not paths. Defaults to none.
   */
  ignoreFiles?: string | readonly string[]
  /**
   * Also respect the user's global excludes file (`core.excludesFile`, or
   * `~/.config/git/ignore`), as git does. Only applies inside a git
   * repository and when `gitignore` is on. Defaults to `true`.
   */
  globalGitignore?: boolean
  /**
   * Match case-insensitively. Defaults to the repository's
   * `core.ignorecase` setting, which git sets to `true` on case-insensitive
   * file systems (macOS, Windows) and leaves `false` elsewhere.
   */
  ignoreCase?: boolean
}

/**
 * The subset of `node:fs` that tinyglobby and fdir accept through their `fs`
 * option.
 */
export interface FsLike {
  readdir: typeof nodeFs.readdir
  readdirSync: typeof nodeFs.readdirSync
  realpath: typeof nodeFs.realpath
  realpathSync: typeof nodeFs.realpathSync
  stat: typeof nodeFs.stat
  statSync: typeof nodeFs.statSync
}

export interface GitignoreFilter {
  /**
   * Whether git would ignore `path`. Relative paths are resolved from `cwd`.
   *
   * Pass `isDirectory` when you know it, or end directory paths with `/`.
   * When neither is given and the answer depends on it (a pattern like
   * `build/` only matches directories), the path is checked on disk once.
   *
   * Paths outside any repository and outside `cwd` are never ignored.
   */
  isIgnored(path: string | URL, isDirectory?: boolean): boolean
  /**
   * Return the paths that are not ignored, preserving order. Paths ending in
   * `/` are treated as directories.
   */
  filter<T extends string>(paths: readonly T[]): T[]
  /**
   * A filesystem adapter for the `fs` option of tinyglobby or fdir. Ignored
   * entries are dropped as each directory is read, so ignored directories
   * are never crawled. Optionally wraps a custom `fs` of your own.
   */
  createFs(base?: Partial<FsLike>): FsLike
  /** An `exclude` callback for fdir's builder: `.exclude(filter.fdirExclude)`. */
  fdirExclude(dirName: string, dirPath: string): boolean
  /**
   * An `exclude` callback for Node's `fs.glob` / `fs.globSync`. Requires
   * `withFileTypes: true`, because in string mode Node sometimes passes only
   * a base name, which can't be located reliably.
   */
  fsGlobExclude(entry: Dirent): boolean
}

interface Scope {
  root: string
  isRepo: boolean
  ig: Ignore
  loaded: Set<string>
}

const toPosix = sep === '/' ? (p: string) => p : (p: string) => p.split(sep).join('/')

function toPath(value: string | URL): string {
  return value instanceof URL || value.startsWith('file:') ? fileURLToPath(value) : value
}

function normalizeIgnoreFiles(value: string | readonly string[] | undefined): string[] {
  const list = value === undefined ? [] : typeof value === 'string' ? [value] : [...value]
  return list.map((name) => {
    // Accept globby-style `**/.prettierignore` for easier migration.
    const stripped = name.replace(/^(\*\*\/)+/, '')
    if (stripped === '' || /[\\/*?[\]{}]/.test(stripped)) {
      throw new TypeError(
        `gitignore-filter: ignoreFiles expects file names such as ".prettierignore", got "${name}"`,
      )
    }
    return stripped
  })
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Create a filter that answers "would git ignore this path?" the way git
 * does: every `.gitignore` in the tree scoped to its own directory, deeper
 * files overriding shallower ones, `.git/info/exclude` and the global
 * excludes file underneath, nested repositories kept separate, and no
 * re-including files inside an ignored directory.
 *
 * Ignore files are read lazily and cached, so only the directories you
 * actually ask about are touched. The filter does not watch for changes;
 * create a new one if ignore files change.
 */
export function createGitignoreFilter(options: GitignoreFilterOptions = {}): GitignoreFilter {
  const base = resolve(options.cwd === undefined ? process.cwd() : toPath(options.cwd))
  const gitignore = options.gitignore ?? true
  const globalGitignore = options.globalGitignore ?? true
  const fileNames = [...(gitignore ? ['.gitignore'] : []), ...normalizeIgnoreFiles(options.ignoreFiles)]
  const active = fileNames.length > 0

  /** dir -> nearest repository root at or above it, or null when there is none. */
  const repoRootCache = new Map<string, string | null>()
  const scopes = new Map<string, Scope>()

  function findRepoRoot(dir: string): string | null {
    const visited: string[] = []
    let current = dir
    let found: string | null = null
    for (;;) {
      const cached = repoRootCache.get(current)
      if (cached !== undefined) {
        found = cached
        break
      }
      visited.push(current)
      if (isRepoRoot(current)) {
        found = current
        break
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    for (const v of visited) repoRootCache.set(v, found)
    return found
  }

  function getScope(root: string, isRepo: boolean): Scope {
    let scope = scopes.get(root)
    if (scope) return scope

    let ignoreCase = options.ignoreCase
    const lowest: string[] = []
    if (isRepo && gitignore) {
      const dirs = resolveGitDirs(root)
      if (dirs) {
        const settings = readRepoSettings(root, dirs, globalGitignore)
        ignoreCase ??= settings.ignoreCase
        // Lowest precedence first: global excludes, then info/exclude.
        if (settings.globalExcludes) lowest.push(...rebasePatterns(settings.globalExcludes, ''))
        if (settings.infoExclude) lowest.push(...rebasePatterns(settings.infoExclude, ''))
      }
    }

    scope = {
      root,
      isRepo,
      ig: ignore({ ignoreCase: ignoreCase ?? false }).add(lowest),
      loaded: new Set(),
    }
    scopes.set(root, scope)
    return scope
  }

  /** The scope (repository, or `cwd` outside any repository) that governs entries of `dir`. */
  function scopeFor(dir: string): Scope | undefined {
    const repoRoot = findRepoRoot(dir)
    if (repoRoot !== null) return getScope(repoRoot, true)
    if (dir === base || isInside(dir, base)) return getScope(base, false)
    return undefined
  }

  /** Read the ignore files of one directory (relative to the scope root) into the scope. */
  function loadDir(scope: Scope, relDir: string): void {
    if (scope.loaded.has(relDir)) return
    scope.loaded.add(relDir)
    for (const name of fileNames) {
      let text: string
      try {
        text = nodeFs.readFileSync(join(scope.root, relDir, name), 'utf8')
      } catch {
        continue
      }
      scope.ig.add(rebasePatterns(text, relDir))
    }
  }

  function isIgnoredAbs(abs: string, isDirectory?: boolean): boolean {
    if (!active) return false
    const scope = scopeFor(dirname(abs))
    if (!scope) return false

    // A repository nested inside the one `cwd` belongs to is its own world,
    // but the outer repository can still ignore the nested one's directory.
    if (scope.isRepo && isInside(scope.root, base) && scopeFor(dirname(scope.root))) {
      if (isIgnoredAbs(scope.root, true)) return true
    }

    const rel = toPosix(relative(scope.root, abs))
    if (rel === '' || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return false

    const parts = rel.split('/')
    // Git never treats its own directory as part of the working tree.
    if (scope.isRepo && parts[0] === '.git') return true

    loadDir(scope, '')
    let relDir = ''
    for (let i = 0; i < parts.length - 1; i++) {
      relDir = relDir === '' ? parts[i]! : `${relDir}/${parts[i]}`
      // Git does not look inside an ignored directory at all.
      if (scope.ig.ignores(`${relDir}/`)) return true
      loadDir(scope, relDir)
    }

    if (isDirectory === true) return scope.ig.ignores(`${rel}/`)
    if (isDirectory === false) return scope.ig.ignores(rel)
    const asFile = scope.ig.ignores(rel)
    const asDir = scope.ig.ignores(`${rel}/`)
    if (asFile === asDir) return asFile
    // Only now does it matter whether this is a directory. Like git, a
    // symlink is not a directory, so use lstat.
    try {
      return nodeFs.lstatSync(abs).isDirectory() ? asDir : asFile
    } catch {
      return asFile
    }
  }

  function isIgnored(path: string | URL, isDirectory?: boolean): boolean {
    let p = toPath(path)
    if (isDirectory === undefined && (p.endsWith('/') || p.endsWith(sep))) isDirectory = true
    p = resolve(base, p)
    return isIgnoredAbs(p, isDirectory)
  }

  /**
   * Everything about a directory's entries that is the same for all of them,
   * worked out once: whether the directory itself is ignored, which scope
   * governs it, and its ignore files loaded. Returns `null` when every entry
   * is ignored and `undefined` when none can be.
   */
  function directoryContext(dirAbs: string): { scope: Scope; prefix: string } | null | undefined {
    if (isIgnoredAbs(dirAbs, true)) return null
    const scope = scopeFor(dirAbs)
    if (!scope) return undefined
    const relDir = toPosix(relative(scope.root, dirAbs))
    loadDir(scope, '')
    if (relDir !== '') {
      let partial = ''
      for (const part of relDir.split('/')) {
        partial = partial === '' ? part : `${partial}/${part}`
        loadDir(scope, partial)
      }
    }
    return { scope, prefix: relDir === '' ? '' : `${relDir}/` }
  }

  function filterEntries<T>(dirPath: unknown, entries: T[]): T[] {
    if (!active || !Array.isArray(entries) || entries.length === 0) return entries
    const dir = resolve(base, String(dirPath))
    const context = directoryContext(dir)
    if (context === null) return []
    if (context === undefined) return entries
    const { scope, prefix } = context
    return entries.filter((entry) => {
      if (typeof entry === 'string') return !isIgnoredAbs(join(dir, entry))
      if (entry instanceof Buffer) return !isIgnoredAbs(join(dir, entry.toString()))
      const d = entry as unknown as Dirent
      const name = String(d.name)
      if (scope.isRepo && prefix === '' && name === '.git') return false
      const isDir = d.isDirectory()
      return !scope.ig.ignores(isDir ? `${prefix}${name}/` : `${prefix}${name}`)
    })
  }

  function createFs(custom: Partial<FsLike> = {}): FsLike {
    const fsBase: FsLike = {
      readdir: custom.readdir ?? nodeFs.readdir,
      readdirSync: custom.readdirSync ?? nodeFs.readdirSync,
      realpath: custom.realpath ?? nodeFs.realpath,
      realpathSync: custom.realpathSync ?? nodeFs.realpathSync,
      stat: custom.stat ?? nodeFs.stat,
      statSync: custom.statSync ?? nodeFs.statSync,
    }
    const readdir = (path: nodeFs.PathLike, opts: unknown, callback?: unknown): void => {
      if (typeof opts === 'function') {
        callback = opts
        opts = undefined
      }
      const cb = callback as (err: NodeJS.ErrnoException | null, entries?: unknown[]) => void
      ;(fsBase.readdir as (...args: unknown[]) => void)(path, opts, (err: NodeJS.ErrnoException | null, entries: unknown[]) => {
        if (err) cb(err, entries)
        else cb(null, filterEntries(path, entries))
      })
    }
    const readdirSync = (path: nodeFs.PathLike, opts?: unknown): unknown[] =>
      filterEntries(path, (fsBase.readdirSync as (...args: unknown[]) => unknown[])(path, opts))
    return {
      ...fsBase,
      readdir: readdir as unknown as FsLike['readdir'],
      readdirSync: readdirSync as unknown as FsLike['readdirSync'],
    }
  }

  return {
    isIgnored,
    filter: (paths) => paths.filter((p) => !isIgnored(p)),
    createFs,
    fdirExclude: (_dirName, dirPath) => isIgnoredAbs(resolve(base, dirPath), true),
    fsGlobExclude(entry) {
      if (typeof entry === 'string') {
        throw new TypeError(
          'gitignore-filter: fsGlobExclude needs Dirent entries. Pass `withFileTypes: true` to fs.glob.',
        )
      }
      const parent = (entry as Dirent & { path?: string }).parentPath ?? (entry as Dirent & { path?: string }).path
      return isIgnoredAbs(resolve(base, parent ?? '.', String(entry.name)), entry.isDirectory())
    },
  }
}
