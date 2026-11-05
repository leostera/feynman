# RFD0013 - Explainers: a story told with the spec's own pictures

- Feature Name: `explainers`
- Status: Proposed
- Author: `leostera`
- Start Date: `2026-11-05`
- Updated: `2026-11-05`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

An explainer is a self-contained web page that tells, as a blog post would, how one spec's
system works and how it breaks. An agent writes the story in
`specs/<spec>.explainer.md`: markdown, plus a few directives (`::play`, `::flow`, `::map`,
`::verdicts`, `::code`) that name parts of the spec. `feynman explain <spec>` turns that file
into one HTML page. The page shows the explorer's own components, inline in the prose: the
playground's stage replaying a scenario or a counterexample, the Flows page's sequence
diagram, the Checks page's cards, the Code tab's sources. Feynman owns every fact and every
picture, recorded from runs at build time. The agent owns the order, the words and the
emphasis. The same command guides the agent from first contact: run without an explainer, it
prints a brief of what the spec holds and how to write one; run with one, it checks every
reference and every claimed failure, and builds only when they're true.

```md
## When the bank's answer is lost

::play{scenario="The bank's answer is lost"}

The box office can't tell a lost answer from a lost request, so it charges again. What stops a
second charge is the order number, which the bank remembers:

::play{breaks="idempotencyKey"}
```

## Motivation

### Explainers are written by hand, and drift

People understand a system from a story with pictures: what the parts are, what happens on
the happy path, what goes wrong and why the design stops it. A good one is tens of kilobytes
of hand-written HTML, with a dozen or more hand-drawn SVG diagrams, numbered sections, and
callouts for "the catch". It works, and it costs: every design change means redrawing
diagrams by hand, and nothing checks that a diagram still shows what the code does.

### The explorer shows everything, and tells nothing

Feynman already derives a map, flows, a playground and checks from a spec (RFD0003). They are
an app: a reader must know where to click, in what order, and why. Chapter 14 of the book
(`book/14-explaining.md`) gives a ten-minute tour of any spec. It's a good tour, and it needs
a person to give it. Nothing in Feynman says *this is the part that matters, look here, now
watch it break*.

### Agents write stories well and facts badly

An agent can read a spec and write a clear account of it. Left alone, it also redraws the
diagrams, paraphrases verdicts, and invents traces that look plausible. Chapter 15 of the
book shows how easily a spec and its story come apart. The facts should come from the
checker, and the agent should only arrange them and explain them.

## Goals

- One HTML file per explainer, readable without a server, that looks like the explorer
  because it is the explorer's components.
- Every fact on the page (a trace, a diagram, a verdict, a count of faults, a code snippet)
  comes from a run of the spec at build time. No picture is drawn by hand.
- A build fails, rather than ship a page whose figures say something the spec no longer does.
- The workflow is driven by Feynman: an agent that only knows `feynman explain` is told what
  to write, then told what's wrong with what it wrote.
- Prose stays prose: markdown an agent writes well and a person reviews in a diff.

## Non-goals

- Feynman does not write prose. No generated text beyond titles and the brief.
- Feynman does not judge prose. It checks references and claims made with directives. It
  does not read sentences for meaning.
- Not a general documentation site, nor MDX: prose can't run code or import components.
- Not a replacement for the explorer. Every figure links to it.
- Not a video or slide format (see Future possibilities).

## Guide-level explanation

### The workflow

An agent is asked: "write an explainer for how a payment works". It runs:

```sh
feynman explain box-office
```

There is no `specs/box-office.explainer.md` yet, so Feynman prints a brief and exits 0:

```text
No explainer for Box office yet. Write specs/box-office.explainer.md, then run this again.

What the spec holds, by the ids directives take:
  scenarios   "Alice buys the last seat" (8 events), "The bank's answer is lost" (11),
              "A restart mid-payment" (12)
  rules       payOnlyTheHolder → without it, holdsAreRespected breaks in 8 events
              idempotencyKey   → without it, chargedOnce breaks in 8 events
              resumePayments   → without it, paymentsEnd breaks in 7 events
              rearmHolds       → without it, holdsEnd breaks in 4 events
  findings    none (every property holds at depth 40)
  limits      Hold lifetime (10 minutes)

A shape that works (book/14-explaining.md, book/16-two-phase-commit.md):
  1. What it is, for whom, in two sentences.        ::map
  2. The happy path.                                 ::play{scenario=…}
  3. One section per rule: what goes wrong without it, and how it's stopped.
                                                     ::play{breaks=…}
  4. What holds, within which bounds.                ::verdicts
  5. What the spec leaves out.

Directives: ::map ::play ::flow ::verdicts ::rules ::code (feynman explain --directives)
```

The agent writes the file:

```md
---
title: Buying the last seat
lede: How the box office sells one seat to one person, takes their money once, and survives a restart.
---

## The parts

::map

Three things talk to each other: people's phones, the theatre's server, and the card processor.
The server keeps the seat in its database, so a restart forgets nothing that matters…

## The happy path

::play{scenario="Alice buys the last seat"}

## The bank's answer is lost

::play{breaks="idempotencyKey"}

Without the order number, the retry charges Alice twice…

::code{step="Bank.charge"}

## What we know, and how sure we are

::verdicts
```

and runs `feynman explain box-office` again. Feynman checks the file and builds it:

```text
specs/box-office.explainer.md
  ! rule resumePayments is not shown: no ::play{breaks="resumePayments"} and no ::rules
  ! section "The happy path" has a figure and no prose
.feynman/explainers/box-office.html
```

Warnings don't stop the build. Errors do:

```text
specs/box-office.explainer.md:14  ✗ ::play{breaks="idempotencyKey"}: without the rule, every
  property still holds. The rule is not needed, so there is nothing to show breaking.
```

### What the reader sees

A page in the explorer's look, light or dark, with a title, the lede and a numbered table of
contents. Between the paragraphs:

- `::map` is the playground's stage at the start of the spec: zones, icons, statuses, rows,
  and the playground file's custom drawing (RFD0003), still and fitted to the column.
- `::play{scenario="…"}` is a small stage with its timeline beside it. It plays the scenario
  with the playground's animation, messages flying and bubbles speaking `say`. The reader can
  pause, step, and go back. It starts paused at the first event, and plays when scrolled into
  view.
- `::play{breaks="rule"}` replays the shortest counterexample of the design without the rule.
  The fault steps are marked, and it stops on the event that breaks the property, which is
  named under the figure with the faults it needed.
- `::play{scenario="…" at=7}` is the stage frozen after event 7, for "look: the hold is gone".
- `::flow{scenario="…"}` is the Flows page's sequence diagram.
- `::verdicts` and `::rules` are the Checks page's cards, with the bounds they hold within.
- `::code{step="Actor.step"}` is the step's sources, highlighted as the Code tab shows them,
  with links to the repository at the built commit.

Every figure has an "Open in the explorer" link to the same point.

## Reference-level explanation

### The file

`<spec>.explainer.md` sits beside the spec, as `<spec>.play.tsx` does. It is CommonMark with
YAML front matter (`title`, `lede`, both required) and leaf directives in the generic
directive syntax (`::name{key="value" key=value}`, alone on a line). Headings of level 2
become the numbered sections. Raw HTML in the markdown is not rendered (escaped), so the
page's look and safety don't depend on the prose.

### Directives

| Directive | Attributes | Resolves to |
| --- | --- | --- |
| `::map` | `at` (event index, with `scenario`), `scenario` | the world at the spec's start, or at that point of a scenario |
| `::play` | exactly one of `scenario`, `breaks`, `finding`, `stuck`; optional `at`, `from`, `to` | a recorded run: events and worlds |
| `::flow` | `scenario` or `breaks` or `finding` | the same recorded run, drawn as a sequence diagram |
| `::verdicts` | `only` (comma-separated property ids) | the report's properties, with bounds |
| `::rules` | `only` (rule names) | the rule verdicts |
| `::code` | `step` (`Actor.key`) or `limit` (name) | the sources, as the bundle carries them (`SourceEntry`) |

- `scenario`: a scenario name, run with `runScenario` as `feynman run` runs it.
- `breaks`: a rule name. The build checks `spec.withoutRules([rule])` with `--only` the
  properties that need it, at the explainer's bounds, and keeps the shortest counterexample.
  Today `RuleVerdict` keeps only its length (`check/rules.ts`). Explainers need the trace,
  so `checkRules` gains an option to return it.
- `finding`: a property id that the report says is broken (or `known`). Its counterexample.
- `stuck`: the report's stuck counterexample.
- `at`, `from`, `to`: event indexes within the run, 1-based, as traces print them.

Bounds are the spec's (`feynman.config.ts` `check`), or front matter `check: { depth: 40 }`,
so an explainer reproduces what `feynman check` says.

### What the build records

`feynman explain` loads the spec as `check` does (types, sources, playground file), runs the
check once, resolves each directive to a **figure**, and writes the page:

```ts
interface Explainer {
  title: string;
  lede: string;
  /** The markdown, with each directive replaced by a placeholder naming its figure. */
  body: string;
  figures: Record<string, Figure>;
  /** What the figures were made from: the commit, dirty or not, the bounds. */
  provenance: { commit: string; dirty: boolean; bounds: Bounds };
}

type Figure =
  | { kind: "map"; world: World }
  | { kind: "play" | "flow"; run: { initial: World; events: Event[]; worlds: World[] }; marks: { breaks?: string; faults: number[] }; window?: { from: number; to: number; at?: number } }
  | { kind: "verdicts"; properties: PropertyResult[]; bounds: Bounds }
  | { kind: "rules"; rules: RuleVerdict[] }
  | { kind: "code"; sources: Record<string, SourceEntry> };
```

The page is the explorer's page (`feynman build`, `cli/serve.ts`): the view's script and
stylesheet inlined, the spec and playground modules embedded (`Embedded.modules`). `Embedded`
gains `explainer?: Explainer`. When it's present, `view/main.tsx` renders `Explainer` instead
of `App`. The spec module stays in the page because the stage draws with the spec's `display`
functions and the playground file's custom nodes. Runs are replayed from their recorded
events, as `sessionFromRun` does. The browser never runs the checker.

### Embeddable components

Today the stage, the timeline and the sequence diagram assume the whole app: a route, a
camera stored in the URL, sidebars, a session that can be edited. Explainers need contained
versions, extracted so the explorer uses the same ones:

- `Scene`: `Stage` plus `useLayout` and the replay (`useReplay` in `Playground.tsx`) for a
  fixed run. Fixed size, fitted, no URL state, read-only: no actions, no drops, no picking.
  Play, pause, step and back. Optionally a `Timeline` beside or under it.
- `SequenceDiagram`: the diagram half of `Flows.tsx`, for one run.
- `VerdictCards`, `RuleCards`: the cards of `Checks.tsx`.
- `CodeBlock`: the Code tab's highlighted source.

This extraction must not change the explorer: its screenshots in `book/images/14` are the
reference.

### The command

```text
feynman explain [spec] [--out FILE|DIR/] [--directives]
```

- With no explainer file: print the brief (above) and exit 0. The brief lists the ids each
  directive takes, the rule verdicts with lengths and faults, the findings, and a suggested
  outline taken from the book's chapter shape, with links to the book.
- With one: lint, then build to `.feynman/explainers/<spec>.html` (or `--out`). Exit 1 on
  errors, 0 otherwise.
- `--directives` prints the directive reference.

`feynman build` includes every spec's explainer, and the explorer links to it from the spec's
header. `feynman check` runs the lint's errors for specs that have an explainer, without
building, so CI catches a stale explainer where it already catches a failing property.

### Lint

Errors (no page is written):

- an unknown directive or attribute, or a missing or contradictory one;
- an id that names nothing: a scenario, rule, property, step or limit not in the spec;
- `breaks` on a rule that isn't needed (without it, every property still holds), or whose
  check was unfinished;
- `finding` on a property that holds;
- `at`, `from` or `to` outside the run;
- the spec fails to load, or its type check fails;
- missing `title` or `lede`.

Warnings:

- a rule that needs showing and isn't shown (`::play{breaks}` or `::rules`), or a finding
  not shown;
- no `::map`;
- a section with a figure and no prose, or prose longer than a limit with no figure;
- the spec has sources marked stale (`feynman lock`): the explainer may describe old code.

### Invariants

1. Every figure is computed from the spec at build time. The markdown can name facts. It
   can't contain them.
2. A page is written only when every directive resolved and every claimed failure
   reproduced.
3. The explainer never changes the model or its verdicts. Removing the file changes nothing
   else.
4. The page records its provenance (commit, dirty, bounds), and shows it in its footer.
5. Prose is rendered without raw HTML. The only components in a page are the ones the
   directives name.

### Security, privacy, and observability

The page embeds the spec's compiled module and, for `::code`, source excerpts, exactly as
`feynman build` does today. An explainer shared outside a team shares that code. The
footer says so, and `::code` is opt-in per directive. No network requests: repository links
are plain links.

### Size

The page carries the explorer: about 3.2 MB of script before compression, about 1 MB gzipped
(`dist/view`), against tens of kilobytes for a hand-written page. It's one file, it works
offline, and `feynman build` already ships the same weight. A static mode (Future
possibilities) would shrink it.

### Rollout and validation

1. Extract the embeddable components, with the explorer unchanged (its tests, and the
   chapter 14 screenshots compared by eye).
2. `checkRules` keeps counterexamples on request. Tests: the trace replays to the break.
3. `feynman explain`: the brief, the lint, the build. Tests for every lint error, against
   `book/specs/13-code/box-office.ts`.
4. The `Explainer` page.
5. The skill gains "Writing an explainer". The book gains a chapter, or a section in 14.
6. The first real explainers: the box office, and one system outside the book (axo remote
   access), written by an agent following only the brief. What it gets wrong goes back
   into the brief and the lint.

## Drawbacks

- **Weight.** A page twenty times the size of a hand-written one.
- **Prose still drifts.** The figures can't go stale, and the sentences around them can.
  The lint catches stale references, not stale meaning.
- **Another file per spec** to keep, review and lock in step with the code.
- **The extraction touches the explorer's busiest components.** It risks regressions in the
  playground for a feature fewer people use.
- **A directive syntax to learn**, small as it is.

## Rationale and alternatives

### Proposed design

Reusing the explorer's components gives explainers the explorer's quality and animation for
the cost of making the components embeddable, which the explorer benefits from too. Recording
runs at build time keeps the page honest and fast, and puts the facts where the checker can
vouch for them. Markdown keeps the part agents and people edit simple.

### Static SVG figures, no script

Draw maps and sequence diagrams as SVG at build time, as hand-written explainers do. Tiny
pages that print and email well. Rejected as the first version: it means a second renderer
for every picture, it loses the animation that makes a race or a lost message obvious, and
the look drifts from the explorer's. It's a good later mode (below).

### The agent writes HTML, with screenshots

What exists today: the agent drives `feynman build`, takes screenshots, and writes the page
(the book's chapter 14 was made this way). It works, and nothing keeps it true. Every
screenshot is stale on the next change.

### A guided tour inside the explorer

Steps over the existing app: "click here, now watch". Cheaper, with no new page. But a tour
is something a person sits through, while an explainer can be read, skimmed, linked to a
section, and reviewed in a diff. The explorer stays the place to explore.

### MDX, or prose in TypeScript

MDX lets prose import any component. That's more power than the page should have, it needs a
JSX build step for prose, and it makes the facts-from-the-checker invariant unenforceable. A
`defineExplainer` in TypeScript keeps everything typed, but prose in string literals is hard
to write and to review. Directives keep the boundary sharp.

### Do nothing

People keep writing explainers by hand, and keep paying to update them. Or
they don't, and the spec's knowledge stays inside the explorer, which only people who already
know where to look can use.

## Prior art

- **Hand-written explainers**: the shape (numbered sections, a picture per idea, "the catch",
  "where we are") and the cost of keeping it current.
- **Learn TLA+, Practical Alloy, the P tutorials, and the book**: a system built up one idea
  at a time, with the tool's own output quoted. The brief's outline comes from them.
- **Distill.pub and explorable explanations** (Bret Victor): figures you can play with,
  inside the text, carry more than static ones. They were also expensive, because each
  figure was built by hand. Here the figures come from the spec.
- **Observable and Jupyter**: prose and live output in one document. The lesson is to keep
  computation out of the prose, or the document becomes the program.
- **`feynman build`** (RFD0003, `cli/serve.ts`): one self-contained page carrying the
  explorer, which this extends.

## Unresolved questions

### Before acceptance

- Is the weight acceptable for the first version, or must static figures come first?
- Should `feynman check` lint explainers by default, or behind a flag?
- Should explainers live beside the spec (`specs/x.explainer.md`) or in a separate tree
  (`docs/explainers/`) that names its spec in front matter? The proposal takes the first, as
  playground files do.

### During implementation

- How small can `Scene` be and still read well: a fixed height, or the run's own layout?
- Autoplay on scroll, or play on click only?
- What does `::play` show for a liveness counterexample's loop: replay the loop, or stop at
  its entry with a note?

### Out of scope

- Explainers that span several specs.
- Translating explainers.

## Future possibilities

- **A static mode**: `--static` draws every figure as SVG and ships no script, for print,
  email, and the 60 KB budget.
- **Change explainers**: from `feynman diff`, a page that explains what a change does to the
  system, the old and new flows side by side, for code review.
- **Explainers on the site**: `feynman.leostera.dev/s/…` serving a repository's explainers next
  to its explorer.
- **Narrated video**: the recorded runs and the prose are a script and a storyboard.
