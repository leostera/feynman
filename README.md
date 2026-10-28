# Feynman

**Understand how a system behaves, and what each change does to it.**

A Feynman spec is one TypeScript file that writes a system's behaviour down as a program
that runs. From it you get a simulator, a model checker, flows, and their diffs.
See [feynman.leostera.dev](https://feynman.leostera.dev).

## This repository

- [`packages/feynman`](packages/feynman): `@leostera/feynman` on npm, the library and CLI.
  It holds its [README](packages/feynman/README.md), [CHANGELOG](packages/feynman/CHANGELOG.md),
  examples, tests, and the agent skill.
- [`packages/share`](packages/share): the explorer of any public git repository, built on
  demand, that the site serves under `/s/`.
- [`sites/feynman.leostera.dev`](sites/feynman.leostera.dev): the website.
- [`docs/rfds`](docs/rfds): design documents.

From the root, `bun run test` tests both packages, and `bun run feynman check` checks the
examples (`feynman.config.ts`).
