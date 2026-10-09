/**
 * The small amount of git plumbing needed to find the same ignore sources git
 * uses: the repository root, `.git/info/exclude`, `core.excludesFile` and
 * `core.ignorecase`. No `git` binary is required.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface GitDirs {
  /** The `.git` directory of this worktree. */
  gitDir: string
  /** The shared `.git` directory (differs from `gitDir` for linked worktrees). */
  commonDir: string
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Resolve the git directories for a repository whose working tree root is
 * `root` (a directory containing `.git`, which may be a directory or a
 * `gitdir:` file as used by submodules and worktrees).
 */
export function resolveGitDirs(root: string): GitDirs | undefined {
  const dotGit = join(root, '.git')
  let gitDir: string
  try {
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit
    } else {
      const text = readText(dotGit)
      const match = text && /^gitdir:\s*(.+?)\s*$/m.exec(text)
      if (!match) return undefined
      gitDir = resolve(root, match[1]!)
    }
  } catch {
    return undefined
  }
  const common = readText(join(gitDir, 'commondir'))
  const commonDir = common ? resolve(gitDir, common.trim()) : gitDir
  return { gitDir, commonDir }
}

type Config = Map<string, string>

/** Parse the subset of git's config format needed here: `[core]` keys. */
export function parseGitConfig(text: string): Config {
  const config: Config = new Map()
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line[0] === '#' || line[0] === ';') continue
    const header = /^\[\s*([^\]\s"]+)(?:\s+"(.*)")?\s*\]/.exec(line)
    if (header) {
      section = header[2] === undefined ? header[1]!.toLowerCase() : `${header[1]!.toLowerCase()}.${header[2]}`
      continue
    }
    const kv = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line)
    if (!kv) continue
    const key = `${section}.${kv[1]!.toLowerCase()}`
    config.set(key, kv[2] === undefined ? 'true' : parseValue(kv[2]))
  }
  return config
}

function parseValue(value: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (c === '"') {
      quoted = !quoted
    } else if (c === '\\' && i + 1 < value.length) {
      const n = value[++i]!
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n
    } else if (!quoted && (c === '#' || c === ';')) {
      break
    } else {
      out += c
    }
  }
  return out.trim()
}

function readConfig(path: string | undefined): Config {
  const text = path && readText(path)
  return text ? parseGitConfig(text) : new Map()
}

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(home(), '.config')
}

/**
 * Global config files in the order git reads them (later wins).
 * `GIT_CONFIG_GLOBAL` replaces both, as it does for git.
 */
function globalConfigPaths(): string[] {
  if (process.env.GIT_CONFIG_GLOBAL) return [process.env.GIT_CONFIG_GLOBAL]
  return [join(xdgConfigHome(), 'git', 'config'), join(home(), '.gitconfig')]
}

function expandPath(value: string, relativeTo: string): string {
  if (value === '~' || value.startsWith('~/')) return join(home(), value.slice(1))
  return isAbsolute(value) ? value : resolve(relativeTo, value)
}

const TRUE = new Set(['true', 'yes', 'on', '1'])

export interface RepoSettings {
  /** `core.ignorecase` from the repository config (git defaults to false). */
  ignoreCase: boolean
  /** Contents of `.git/info/exclude`, if any. */
  infoExclude: string | undefined
  /** Contents of the global excludes file, if any. */
  globalExcludes: string | undefined
}

/** Read the settings that affect ignore matching for the repository at `root`. */
export function readRepoSettings(root: string, dirs: GitDirs, withGlobal: boolean): RepoSettings {
  const local = readConfig(join(dirs.commonDir, 'config'))
  const merged: Config = new Map()
  for (const path of globalConfigPaths()) for (const [k, v] of readConfig(path)) merged.set(k, v)
  for (const [k, v] of local) merged.set(k, v)

  const ignoreCase = TRUE.has((local.get('core.ignorecase') ?? 'false').toLowerCase())

  let globalExcludes: string | undefined
  if (withGlobal) {
    const configured = merged.get('core.excludesfile')
    const path = configured ? expandPath(configured, root) : join(xdgConfigHome(), 'git', 'ignore')
    globalExcludes = readText(path)
  }

  return {
    ignoreCase,
    infoExclude: readText(join(dirs.commonDir, 'info', 'exclude')),
    globalExcludes,
  }
}

/** Whether `dir` is the root of a git working tree (contains `.git`). */
export function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

