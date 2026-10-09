/**
 * tinyglobby with globby's `gitignore` and `ignoreFiles` options.
 *
 *   import { glob } from 'gitignore-filter/tinyglobby'
 *   await glob('**\/*.ts', { cwd, gitignore: true })
 *
 * Ignored directories are pruned while crawling (through tinyglobby's `fs`
 * option), not filtered afterwards.
 */
import { glob as tinyGlob, globSync as tinyGlobSync, type GlobOptions } from 'tinyglobby'
import { createGitignoreFilter } from './index.js'

export interface GitignoreGlobOptions extends GlobOptions {
  /** Respect `.gitignore` files (plus `.git/info/exclude` and the global excludes file). Defaults to `true`. */
  gitignore?: boolean
  /** Extra gitignore-syntax ignore files to respect, e.g. `'.prettierignore'`. */
  ignoreFiles?: string | readonly string[]
  /** Respect git's global excludes file. Defaults to `true`. */
  globalGitignore?: boolean
}

type Patterns = string | readonly string[]

function prepare(
  a: Patterns | GitignoreGlobOptions,
  b?: Omit<GitignoreGlobOptions, 'patterns'>,
): [Patterns | undefined, GlobOptions] {
  const hasPatterns = typeof a === 'string' || Array.isArray(a)
  const { gitignore = true, ignoreFiles, globalGitignore, ...rest } = (hasPatterns ? b ?? {} : a) as GitignoreGlobOptions
  if (gitignore || (ignoreFiles !== undefined && ignoreFiles.length > 0)) {
    const filter = createGitignoreFilter({ cwd: rest.cwd, gitignore, ignoreFiles, globalGitignore })
    rest.fs = filter.createFs(rest.fs as never)
  }
  return [hasPatterns ? (a as Patterns) : undefined, rest]
}

export function glob(patterns: Patterns, options?: Omit<GitignoreGlobOptions, 'patterns'>): Promise<string[]>
export function glob(options: GitignoreGlobOptions): Promise<string[]>
export function glob(a: Patterns | GitignoreGlobOptions, b?: Omit<GitignoreGlobOptions, 'patterns'>): Promise<string[]> {
  const [patterns, options] = prepare(a, b)
  return patterns === undefined ? tinyGlob(options) : tinyGlob(patterns, options)
}

export function globSync(patterns: Patterns, options?: Omit<GitignoreGlobOptions, 'patterns'>): string[]
export function globSync(options: GitignoreGlobOptions): string[]
export function globSync(a: Patterns | GitignoreGlobOptions, b?: Omit<GitignoreGlobOptions, 'patterns'>): string[] {
  const [patterns, options] = prepare(a, b)
  return patterns === undefined ? tinyGlobSync(options) : tinyGlobSync(patterns, options)
}
