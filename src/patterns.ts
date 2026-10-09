/**
 * Turning the text of a gitignore-style file into rules that can all live in
 * a single `ignore` instance rooted at the repository root.
 *
 * Why rebase at all: `ignore` matches paths against rules but has no idea which
 * directory a rule came from. Git scopes the rules in `src/.gitignore` to
 * `src/`, so `/build` there means `src/build` and `*.log` means `src/**\/*.log`.
 * Rewriting every rule relative to the root, and adding the files in git's
 * precedence order (lowest first), lets `ignore`'s "last matching rule wins"
 * and "an excluded directory can't have its contents re-included" logic
 * reproduce git's layering exactly.
 */

/** Characters that have to be escaped when a literal directory name becomes part of a pattern. */
const SPECIAL = /[\\*?[\]]/g

/** Escape a literal path segment (or several, joined by `/`) for use inside a gitignore pattern. */
export function escapeLiteral(path: string): string {
  return path.replace(SPECIAL, (c) => `\\${c}`)
}

/** Remove trailing spaces that are not escaped with a backslash, as git does. */
function trimTrailingSpaces(line: string): string {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ') {
    // Count the backslashes directly before this space.
    let slashes = 0
    let i = end - 2
    while (i >= 0 && line[i] === '\\') {
      slashes++
      i--
    }
    if (slashes % 2 === 1) break // the space is escaped, keep it
    end--
  }
  return line.slice(0, end)
}

/**
 * Parse the contents of one ignore file and return its rules rebased so they
 * apply relative to the scope root.
 *
 * @param content The raw file contents.
 * @param dir The directory the file lives in, relative to the scope root,
 *   using `/` separators. `''` for the root itself.
 */
export function rebasePatterns(content: string, dir: string): string[] {
  const out: string[] = []
  // A UTF-8 byte order mark at the start of the file is skipped by git.
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  const prefix = dir === '' ? '' : `${escapeLiteral(dir)}/`

  for (const raw of content.split('\n')) {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    line = trimTrailingSpaces(line)
    if (line === '' || line[0] === '#') continue

    let negative = false
    if (line[0] === '!') {
      negative = true
      line = line.slice(1)
    }
    if (line === '') continue

    if (prefix === '') {
      out.push((negative ? '!' : '') + line)
      continue
    }

    // A trailing (unescaped) slash means "directories only". Keep it aside.
    let dirOnly = false
    if (line.endsWith('/') && !isEscapedAt(line, line.length - 1)) {
      dirOnly = true
      line = line.slice(0, -1)
    }

    let body: string
    if (line[0] === '/') {
      // Anchored to the directory of the ignore file.
      body = line.slice(1)
    } else if (line.includes('/')) {
      // A slash anywhere but the end also anchors the pattern.
      body = line
    } else {
      // No slash: matches at any depth below the ignore file's directory.
      body = `**/${line}`
    }
    if (body === '' || body === '**/') continue

    out.push(`${negative ? '!' : ''}${prefix}${body}${dirOnly ? '/' : ''}`)
  }
  return out
}

/** Whether the character at `index` is preceded by an odd number of backslashes. */
function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}
