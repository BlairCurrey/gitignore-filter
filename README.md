# gitignore-filter

[![npm](https://img.shields.io/npm/v/gitignore-filter)](https://www.npmjs.com/package/gitignore-filter) [![CI](https://github.com/BlairCurrey/gitignore-filter/actions/workflows/ci.yml/badge.svg)](https://github.com/BlairCurrey/gitignore-filter/actions/workflows/ci.yml)

Respect `.gitignore` files exactly the way git does: with [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [fdir](https://github.com/thecodrr/fdir), Node's built-in `fs.glob`, or any list of paths. Every answer is tested against git itself.

It also handles other ignore files that use gitignore syntax, such as `.prettierignore` and `.eslintignore`.

```js
import { glob } from "gitignore-filter/tinyglobby";

const files = await glob("**/*.ts", { cwd }); // .gitignore respected, like globby's gitignore: true
```

## Why this exists

[globby](https://github.com/sindresorhus/globby) has a `gitignore: true` option. tinyglobby, the lighter replacement recommended by [e18e](https://e18e.dev), deliberately leaves it out, so projects that move off globby lose gitignore support. Today the options are:

- **Stay on globby** and keep its 24 installed packages.
- **Shell out to `git ls-files`**, the [documented workaround](https://superchupu.dev/tinyglobby/migration#gitignore). That needs git installed and a `.git` folder present, so it breaks in Docker build contexts, unpacked tarballs and some CI checkouts.
- **Write your own `.gitignore` handling**, which is harder than it looks (subfolder scoping, anchored patterns, re-includes, etc.).
- **Drop the feature**, as several tools have, and let users trip over generated files, build output and secrets that suddenly show up.

`gitignore-filter` is that missing piece and lets `tinyglobby` stay tiny ([tinyglobby#92](https://github.com/SuperchupuDev/tinyglobby/issues/92)).

## What does this add over the `ignore` package?

[`ignore`](https://github.com/kaelzhang/node-ignore) is the rule engine: give it gitignore rules and it tells you whether a path matches them. This package uses it, and does everything around it that git does and `ignore` leaves to you:

|                                                                                             | `ignore` | `gitignore-filter` |
| ------------------------------------------------------------------------------------------- | :------: | :----------------: |
| Matches a path against gitignore rules                                                      |    ✓     |  ✓ (via `ignore`)  |
| Finds every `.gitignore` in the tree, root and subfolders                                   |          |         ✓          |
| Scopes each file's rules to its own folder (`/build` in `src/.gitignore` means `src/build`) |          |         ✓          |
| Lets deeper files override shallower ones, in git's precedence order                        |          |         ✓          |
| Reads `.git/info/exclude` and the global gitignore (`core.excludesFile`)                    |          |         ✓          |
| Reads `core.ignorecase`, so matching is case-insensitive where git's is                     |          |         ✓          |
| Stops at repository boundaries; nested repos and submodules keep their own rules            |          |         ✓          |
| Knows which paths are folders, so `build/` only matches directories                         |          |         ✓          |
| Skips ignored folders while crawling instead of filtering afterwards                        |          |         ✓          |
| Works the same with `.prettierignore`, `.eslintignore` and other gitignore-style files      |          |         ✓          |
| Checked against `git` on hundreds of generated repositories on every CI run                 |          |         ✓          |

In short, `ignore` answers "do these rules match this path?" and `gitignore-filter` answers "would git ignore this file in this project?"

## Is tinyglobby + this still smaller than globby?

Yes, by a wide margin. Measured from a clean install of production dependencies (`pnpm size`):

<!-- size-table -->

| What you install                         | gitignore support | Packages | Size on disk |
| ---------------------------------------- | :---------------: | -------: | -----------: |
| globby 16.2.4                            |         ✓         |       24 |       773 kB |
| **tinyglobby 0.2.17 + gitignore-filter** |         ✓         |    **5** |   **364 kB** |
| tinyglobby 0.2.17 alone                  |                   |        3 |       183 kB |
| fast-glob 3.3.3                          |                   |       18 |       513 kB |
| glob 13.0.6                              |                   |        7 |     6,334 kB |

<!-- /size-table -->

That's about a fifth of globby's packages and less than half its size. glob and fast-glob are shown for reference only: neither has ever supported `.gitignore`. (The names are easy to mix up. **glob** is the original Node globbing library; **fast-glob** is a faster rewrite; **globby** is built on fast-glob and adds conveniences, including `gitignore: true`; **tinyglobby** is the lightweight replacement for fast-glob and globby, without that option.) The two packages added on top of tinyglobby are this one (about 63 kB including this README) and `ignore` (about 121 kB, with no dependencies of its own). `ignore` is often already in a project's tree anyway: it has hundreds of millions of weekly downloads.

It's also faster. On a synthetic monorepo with about 25,000 files, most of them in `node_modules`, `dist` and `coverage` folders (`pnpm bench`):

<!-- bench-table -->

| Approach                                          | Median time |              Matches git              |
| ------------------------------------------------- | ----------: | :-----------------------------------: |
| globby `{ gitignore: true }`                      |      122 ms |                   ✓                   |
| tinyglobby + documented `git ls-files` workaround |      100 ms |                   ✓                   |
| **tinyglobby + gitignore-filter**                 |   **28 ms** |                   ✓                   |
| tinyglobby with no gitignore support (baseline)   |       28 ms | returns 24,951 files instead of 5,151 |

<!-- /bench-table -->

Measured on an Apple M2 Max, Node 24.21, median of 15 runs. Your numbers will differ; the ordering was the same on Linux and macOS.

tinyglobby + gitignore-filter is so much faster than globby because:

1. **It crawls once.** globby crawls the tree once just to find the `.gitignore` files, then again to glob. gitignore-filter reads each folder's `.gitignore` when the crawl reaches that folder.
2. **It doesn't `stat` every result.** globby calls `stat` on each result (about 5,000 here) to check whether it's a folder. The directory listing already says which entries are folders, so gitignore-filter doesn't need to.

It's as fast as tinyglobby with no gitignore support because ignored folders are never opened: the crawl opens about 300 directories instead of about 1,600, which saves about as much time as checking the rules costs.

## Install

```sh
npm install gitignore-filter
```

For the tinyglobby helper, also install `tinyglobby` (an optional peer dependency). Requires Node.js 20 or later.

## Usage

### With tinyglobby (migrating from globby)

`gitignore-filter/tinyglobby` exports tinyglobby's `glob` and `globSync` with globby's `gitignore` and `ignoreFiles` options added. `gitignore` defaults to `true`:

```diff
- import { globby } from 'globby'
+ import { glob } from 'gitignore-filter/tinyglobby'

- const files = await globby('src/**/*.vue', { cwd, gitignore: true })
+ const files = await glob('src/**/*.vue', { cwd })
```

All tinyglobby options work as usual. Ignored folders are skipped while crawling, not filtered afterwards.

```js
import { glob, globSync } from "gitignore-filter/tinyglobby";

await glob(["**/*.js", "!**/*.test.js"], {
  cwd,
  ignoreFiles: [".prettierignore"],
});
globSync({
  patterns: ["**/*"],
  cwd,
  dot: true,
  gitignore: false,
  ignoreFiles: ".eslintignore",
});
```

Migrating from tinyglobby's `git ls-files` workaround? Delete the helper and import `glob` from here instead.

### Checking paths directly

```js
import { createGitignoreFilter } from "gitignore-filter";

const filter = createGitignoreFilter({ cwd });

filter.isIgnored("dist/app.js"); // true
filter.isIgnored("src/index.ts"); // false
filter.isIgnored("build", true); // pass true when you know it's a directory
filter.isIgnored("build/"); // or end the path with /

filter.filter(["src/a.ts", "dist/a.js", "README.md"]); // ['src/a.ts', 'README.md']
```

Relative paths are resolved from `cwd`; absolute paths and `file:` URLs work too. If you don't say whether a path is a directory and the answer depends on it (`build/` only matches directories), the path is checked on disk once.

### With your own tinyglobby `fs` option, or fdir

`createFs()` returns a drop-in for the `fs` option of tinyglobby and fdir. It drops ignored entries as each folder is read, so ignored folders are never crawled. Pass your own `fs` to wrap it.

```js
import { fdir } from "fdir";
import { createGitignoreFilter } from "gitignore-filter";

const filter = createGitignoreFilter({ cwd });
const files = new fdir({ fs: filter.createFs() })
  .withRelativePaths()
  .crawl(cwd)
  .sync();

// Or only prune directories:
new fdir().exclude(filter.fdirExclude).crawl(cwd).sync();
```

### With Node's `fs.glob`

Use `withFileTypes: true`. In string mode Node sometimes passes only a base name to `exclude`, which can't be located reliably.

```js
import { globSync } from "node:fs";

const filter = createGitignoreFilter({ cwd });
const files = globSync("**/*", {
  cwd,
  withFileTypes: true,
  exclude: filter.fsGlobExclude,
})
  // Node's fs.glob can still return a few files that `exclude` rejected
  // (nodejs/node#63049); this line makes the result exact until that's fixed.
  .filter((entry) => !filter.fsGlobExclude(entry));
```

## Options

`createGitignoreFilter(options)` and the tinyglobby helper accept:

| Option            | Default         | Description                                                                                                                                                                                                                                         |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`             | `process.cwd()` | Where relative paths are resolved from, and where the search for the repository starts.                                                                                                                                                             |
| `gitignore`       | `true`          | Respect `.gitignore` files, `.git/info/exclude` and the global excludes file.                                                                                                                                                                       |
| `ignoreFiles`     | none            | Extra gitignore-syntax files to respect, by name: `'.prettierignore'` or `['.prettierignore', '.eslintignore']`. globby-style `'**/.prettierignore'` is accepted too. They're found and scoped exactly like `.gitignore`, and layered on top of it. |
| `globalGitignore` | `true`          | Respect the user's global excludes file, as git does. Set it to `false` for results that don't depend on the machine.                                                                                                                               |
| `ignoreCase`      | repo setting    | Match case-insensitively. Defaults to the repository's `core.ignorecase`, which git sets to `true` on macOS and Windows.                                                                                                                            |

## How it decides

It follows git's own rules:

1. Every `.gitignore` applies only within its own folder, with patterns relative to that folder.
2. A pattern with no slash (`*.log`) matches at any depth; a leading or middle slash (`/dist`, `a/b`) anchors it; a trailing slash (`build/`) matches only directories.
3. Precedence, lowest to highest: the global excludes file, then `.git/info/exclude`, then `.gitignore` files from the root down. The last matching rule wins, so a deeper file can override a shallower one.
4. Nothing inside an ignored folder can be re-included (`logs/` followed by `!logs/keep.log` still ignores `keep.log`; use `logs/*` instead), and git doesn't read ignore files inside ignored folders.
5. A nested repository or submodule uses only its own rules, though the outer repository can still ignore its folder.
6. Outside a git repository (for example, a Docker build context with no `.git`), `.gitignore` files under `cwd` are still applied the same way.
7. The `.git` folder itself is always treated as ignored, since git never treats it as part of the working tree.

Ignore files are read lazily and cached, so only the folders you ask about are touched. The filter doesn't watch for changes; create a new one if ignore files change.

## Tested against git

The test suite never checks answers against a hand-written expectation of how gitignore works. Each test builds a real repository, asks git (`git ls-files --others --ignored --exclude-standard`) which files it ignores, and requires this package to give the same answer for every file. It also checks that the tinyglobby helper returns exactly git's list of non-ignored files.

On top of hand-written scenarios, a randomized test generates hundreds of repositories with random folders and random ignore files and compares each against git. Runs are reproducible from a seed. CI runs everything on Linux, macOS and Windows across Node 20, 22 and 24, plus a weekly run of 5,000 random repositories with a fresh seed.

```sh
pnpm test                                  # everything, 300 random repositories
FUZZ_RUNS=5000 pnpm test:only              # more random repositories
FUZZ_SEED=12345 FUZZ_RUNS=1 pnpm test:only  # reproduce one case
```

## Limits

- **It answers "is this path ignored?", not "is it tracked?"** Like globby's `gitignore` option and `git check-ignore --no-index`, it doesn't read git's index. A file that's already committed but matches an ignore pattern is reported as ignored.
- **The system-wide git config** (`/etc/gitconfig`) and `[include]` sections are not read when looking up `core.excludesFile`. The repository config, `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` and `GIT_CONFIG_GLOBAL` are.
- **Only gitignore-syntax files** belong in `ignoreFiles`. `.dockerignore`, for example, follows different rules.

## License

MIT
