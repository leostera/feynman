# Writing specs with Feynman

*A book about describing how systems behave, checking them, and explaining them.*

Code tells you what each part does. A spec tells you what happens when the parts meet: two
people press the button at once, the answer never comes back, the server restarts halfway
through, the timer fires first. This book teaches you to write those specs with Feynman, in
TypeScript, and to read what the checker tells you about them.

It's written for engineers who know TypeScript and have shipped a distributed system, even a
small one, like a web app with a database and a payment provider. You don't need to know any
formal methods. The book never teaches the syntax for its own sake. It teaches the judgement:
what's an actor, where a step ends, which faults to model, what to leave out, and when to
believe a verdict.

Every chapter builds its specs step by step, and every step is a real file in
[`specs/`](specs) that you can check yourself. Every piece of checker output in the book was
copied from a real run.

## Part I. The box office

One system, built up a chapter at a time: a theatre selling its last seat.

1. [A first spec](01-a-first-spec.md): a bank transfer, a bug, and its fix, all at once.
2. [Getting set up](02-getting-set-up.md): install, the commands, and where specs live.
3. [Things and what they hold](03-actors-and-actions.md): actors, state and actions.
4. [Telling each other](04-messages.md): messages, and the race they make possible.
5. [What must stay true](05-properties.md): properties, and reading a counterexample.
6. [Showing that it happens](06-scenarios.md): scenarios, the flows a reader should see.
7. [When the timer fires first](07-timers.md): timers, without a clock.
8. [When the answer never comes](08-faults.md): lost messages, failed calls, and retries.
9. [When it restarts right here](09-restarts.md): crashes, and what's on disk.
10. [Does it ever finish?](10-liveness.md): liveness and fairness.
11. [Which part does the work?](11-rules.md): rules, and checking that each safeguard is needed.
12. [How sure are we?](12-bounds.md): bounds, symmetry, and the four verdicts.

## Part II. Real code

13. [Pointing at the code](13-modelling-code.md): reading code into a spec, sources, lock, and diff.
14. [Explaining it to the new person](14-explaining.md): the playground, flows and checks.
15. [My agent found a bug. Is it real?](15-triage.md): triaging findings, and `✓`s that lie.

## Part III. Well-known systems

16. [Two-phase commit](16-two-phase-commit.md): two databases agreeing, in seven steps.
17. [The outbox](17-outbox.md): saving and telling, when either can fail.
18. [Leases and fencing tokens](18-leases.md): why a lock is never enough.
19. [A counter in two places](19-counters.md): from a lost like to a CRDT.

## Appendices

- [A. Coming from TLA+, Alloy or P](A-from-other-tools.md)
- [B. Quick reference](B-quick-reference.md)

## How to read it

Read Part I in order. Each chapter adds one idea to the same system, and later chapters use
everything before them. Parts II and III can be read in any order after that.

Do the exercises. Most take a few minutes, and the checker tells you whether you got it right.
To run a step:

```sh
bun packages/feynman/bin/feynman.ts check book/specs/16-two-phase-commit/7-a-restart.ts --depth 30
```

or, with Feynman installed in your own project, copy the file next to your `package.json` and
run `feynman check <file>`. The comment at the top of every step says what to expect from it.

## Where it came from

The book owes its shape to three others: Hillel Wayne's [Learn TLA+](https://learntla.com),
Alcino Cunha, Nuno Macedo, Julien Brunel and David Chemouil's [Practical Alloy](https://practicalalloy.github.io), and the
[P language tutorials](https://p-org.github.io/P/tutorial). Chapter 16 follows the P
two-phase-commit tutorial, and chapter 18 follows Martin Kleppmann's
[How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html).
