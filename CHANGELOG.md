# Changelog

What changed in this repository outside the npm package, newest first:

- the site, [feynman.leostera.dev](https://feynman.leostera.dev) (`sites/feynman.leostera.dev`);
- the explorer of any public repository, which the site serves under `/s/` (`packages/share`);
- how the repository is laid out.

The site and the explorer are deployed, not released, so entries are dated.
`@leostera/feynman` has its own changelog, release by release, in
[`packages/feynman/CHANGELOG.md`](packages/feynman/CHANGELOG.md).

## 2026-10-28

### Repository

- The package moves to `packages/feynman`. The root is a private workspace of
  `packages/feynman`, `packages/share` and the site, and its scripts run the package's:
  - `bun run test` tests both packages;
  - `bun run feynman check` checks the examples.

  `feynman.config.ts` stays at the root, pointing at `packages/feynman/examples`, because the
  explorer builds a repository from its root. Pi loads the skill from `packages/feynman`.

### Site

- The site no longer builds simulator pages of its own. Every `/s/<host>/<path>` is built on
  demand by the explorer and kept by commit, so the following are gone:
  - `sims.json`, `scripts/pages.ts` and `bun run sim`;
  - the pinned axo page, whose commit no longer built, failing every site build.

  `static/` is now `public/`, committed as is.
- The landing page shows three moments to use Feynman, each on a real playground:
  - designing a system (two-phase commit);
  - understanding one (axo's remote access);
  - checking a change (payments).

  Each opens its explorer, at that scenario.
- `llms.txt` says how to open any repository's explorer, and links the examples and axo.
- A deep purple accent in place of Kumo's blue.
- `/s/*` is served by the site's own Worker, which mounts the explorer: one deployment.

### Explorer (`packages/share`)

- Limits:
  - 60 requests a minute per client IP under `/s`;
  - 2 builds a minute per client IP, counted only when the page is not stored yet;
  - one build at a time for the whole service;
  - 200 builds a UTC day.

  Past a limit it answers 429 or 503 with `Retry-After`.
- A build that fails for a reason that would not change (no such repository, specs that do
  not build) is answered from R2 for an hour, without starting another container.
- Refs are listed with git protocol v2 (`HEAD`, branches and tags only), so pull-request refs
  never arrive. The v0 fallback reads at most 4 MB.
- The build container runs Feynman 0.11.0 on Bun 1.4.4.
- It is a library, a Hono app the site mounts at `/s`. Its Durable Objects are reached through
  the host's `ctx.exports`, since cf refuses a container on a Durable Object bound by name.

## 2026-10-27

### Explorer (`packages/share`)

- `feynman.leostera.dev/s/<host>/<path>?ref=<branch, tag or commit>` shows the explorer of any
  public git repository with a `feynman.config.ts`.
  - It resolves the ref with git's smart HTTP protocol, and serves the page for that commit
    from R2.
  - Otherwise it builds the page. A Durable Object per repository and commit starts a
    container (Bun, git and the published Feynman), fetches that commit, runs
    `feynman build`, and stores the page.
  - The container reaches only the repository's host.

### Site

- The page leads with what Feynman is for: designing, understanding and checking systems. It
  says up front that Feynman is a TypeScript library and CLI, with a spec and its check in the
  hero.
- It shows the Code view and shareable sessions, and lists the new examples.

## 2026-10-26

### Repository

- The repository is the package. The six workspace packages and the npm staging script are
  gone.
  - Sources live in `src/`, tests in `test/`, the CLI in `bin/` and examples in `examples/`.
  - `npm publish` builds the view, type-checks and tests first.
  - The TLA+ and P oracle suites are `*.oracle.ts`, run by `bun run oracles`.

### Site

- Redone for specs: one runnable model of a system, from which Feynman derives a simulator, a
  model checker tested against TLC and P, flows and their diffs, and links to the code.
- Simulators are published under `/s/`, starting with axo's remote access and the examples.
- Built for agents too:
  - the built `index.html` holds the page itself, so readers that run no script get all of it;
  - `/llms.txt` says what Feynman is and lists everything;
  - `/SKILL.md` is the skill.
- Snippets are real files, highlighted at build time with Shiki in both modes, with a copy
  button. They cover a complete spec, the install commands, and a prompt to hand an agent.
- It follows Kumo's design rules:
  - sentence-case labels;
  - semibold, not bold;
  - no tracking on headings;
  - no colour transition on hover.

## 2026-10-25

### Repository

- The extracted-model packages are retired (RFD0001): `@feynman/model`, `@feynman/modeler`,
  `@feynman/pi-feynman` and `@feynman/renderer`. The root became a Pi package that ships the
  `feynman` skill.

### Site

- [feynman.leostera.dev](https://feynman.leostera.dev): a one-page Kumo site, deployed to the
  account that holds leostera.dev.
