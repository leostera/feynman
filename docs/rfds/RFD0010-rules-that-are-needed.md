# RFD0010 - Rules that are needed

- Feature Name: `rules`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-10-30`
- Updated: `2026-10-30`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

A spec can name the rules of its design: the parts that exist to keep a property true. A
property then says which rules it needs, by reference:

```ts
const pendingRule = spec.defineRule({ name: "pendingRule", description: "A read waits behind a push it has not seen confirmed." });
// where the rule applies:
if (pendingRule.on && state.pending.length) return void state.waiting.push(msg);
// and in the properties:
ackedPushesAreVisible: { description: "…", always: (w) => …, needs: [pendingRule] },
```

`feynman check` then also checks the design without each rule, and expects every property
that needs it to break. When one doesn't, the check fails: either the rule does nothing, or
the property is too weak to notice. `feynman check --without pendingRule` checks the design
without the rule, with its counterexamples, the way a reader would ask "what goes wrong if
we drop this?".

## Motivation

A property that holds says the design is safe. It doesn't say which parts of the design make
it safe, or whether the property would notice if they were gone. Agents writing specs keep
asking both questions, and answer them by hand:

- In one session, an agent checked the same thing three times on two specs: it copied the
  spec with `sed`, flipped `const PENDING_RULE = true` to `false`, renamed the copy, checked
  it, read that `ackedPushesAreVisible` broke in 5 events, and deleted the copy. A third time it
  rewrote a handler in a copy to drop a barrier and checked that `readsNeverGoBack` broke.
- The examples do the same with a factory: `retriedCall("buggy")` and `retriedCall("fixed")`,
  exported as `default` and `fixed`. The CLI only loads the default export, so the fixed
  variant is only checked by Feynman's own tests.

Each time, the result is worth keeping: "without the pending rule, a read misses an
acknowledged push" is the clearest explanation of why the rule exists. But it lives in a
transcript, not in the spec, so nothing re-checks it when the design changes.

There is a second reason. A property that still holds after its rule is removed means one of
three things, all worth knowing:

- the rule is dead (another part of the design already prevents the bug);
- the property is too weak to see the bug it was written for;
- the bounds are too small to reach it.

Mutation testing finds weak tests in the same way. Here the mutations are named by the
author, who knows which parts of the design are load-bearing.

## Goals

- A spec names its rules. Each is a typed value the spec holds, with a name and a
  description, not a string: a property that needs it says so by reference, and the type
  checker catches a misspelt or deleted rule.
- A rule is on by default. Turning it off is a variant of the design, built from the same
  spec, with no copy.
- `feynman check` checks each claim: without the rule, each property that needs it breaks. A
  claim that doesn't hold fails the check, as a broken property does.
- `feynman check --without RULE` checks the design without one or more rules, with full
  counterexamples and `--as-scenario`.
- Both engines, `--json`, and the explorer show the rules and their verdicts.

## Non-goals

- **Parameters other than on/off** (a replica count, a timeout length, a page size).
  `instances` and bounds cover counts. A rule is a part of the design that is there or not.
- **Automatic mutations** (deleting random transitions or guards). The author names what
  matters. See Future possibilities.
- **Migrating the examples** from `buggy`/`fixed` factories to rules. They could follow, but
  their oracles and corpus are built around the factory, and that is a separate change.

## Guide-level explanation

### Naming a rule

A rule is defined in the builder, before the actors that read it, like a zone:

```ts
export default defineSpec("Ref view", { messages: { ... } }, (spec) => {
  const pendingRule = spec.defineRule({
    name: "pendingRule",
    description: "A read waits behind a push the shard has not confirmed to every copy.",
  });

  const Copy = spec.defineActor({
    ...
    transitions: {
      [Read]: {
        description: "Answers a read, unless a push is pending.",
        run(state, msg, ctx) {
          if (pendingRule.on && state.pending.length) return void state.waiting.push(msg);
          ctx.reply(Answer, { version: state.version });
        },
      },
    },
  });

  spec.defineProperties({
    ackedPushesAreVisible: { description: "A read after an acknowledged push sees it.", always: (w) => …, needs: [pendingRule] },
    readsNeverGoBack: { description: "A read sees at least what an earlier one saw.", always: (w) => …, needs: [pendingRule] },
  });
});
```

`pendingRule.on` is `true` in the spec as written, and `false` in the variant without it.
The claim lives on the property, next to what it says, as a reference to the rule. There is
no string to misspell, and deleting a rule that a property needs is a type error. The rule's
`name` is how the CLI and the reports refer to it (`--without pendingRule`). Two rules with
one name are a definition error.

### What `feynman check` does

After the spec's own verdicts, the check lists its rules:

```
  rules
    ✓ pendingRule  needed: without it, ackedPushesAreVisible breaks (5 events), readsNeverGoBack breaks (6 events)
    ✗ barrier      not needed by readsNeverGoBack: it held without the rule, in every state
    ~ quorum       needed by onlyCommittedIsShown? it held without the rule in the 300,000 states explored, not all of them
```

- **✓** Each property that needs the rule broke without it. The event counts are the
  shortest counterexamples.
- **✗** A property held without the rule, exhaustively. The check fails: the rule is dead, or
  the property is too weak.
- **~** A property held without the rule, but the search stopped early. It's not a failure,
  as with any unfinished verdict.

A rule that no property needs isn't checked. It can still be turned off with `--without`.

### Looking at the design without a rule

```
feynman check ref-view --without pendingRule
feynman check ref-view --without pendingRule --only readsNeverGoBack --as-scenario
```

This checks the variant as if it were the spec: every property, full counterexamples, and a
counterexample as scenario code. The report's first line names the rules that are off.
`feynman run` and `feynman dev` take `--without` too, so a scenario can be watched in the
design without the rule.

## Reference-level explanation

### Data model

- `SpecBuilder` gains `defineRule(def: { name: string; description: string }): Rule`, with
  `Rule = { readonly name: string; readonly description: string; readonly on: boolean }`.
- `PropertyDef` gains `needs?: readonly Rule[]`.
- `Spec` gains `rules: RuleInfo[]`, each `{ name, description, neededBy: string[] }` (the
  ids of the properties that need it), and `without(names: string[]): Spec`.
- `without` re-runs the builder with those rules off. `defineSpec` keeps the builder for this.
  The variant's `name` is `"Ref view without pendingRule"`. Its `rules` say which are off.
- `Report` gains `rules?: RuleVerdict[]`, each `{ name, neededBy: { property, verdict:
  "breaks" | "holds" | "unfinished", events? }[] }`.

### Semantics

- A rule's claim is checked by checking `spec.without([rule])` with the same bounds, seeds
  and instances as the spec, restricted to the properties that need it.
- That search stops as soon as every one of them has broken. A search that has found every
  property broken has nothing left to learn, so a ✓ costs about as much as finding the
  shortest counterexamples, not a full search.
- The verdict per property is the variant's: broken (✓ for the claim), held exhaustively
  (✗), held unfinished (~).
- A property that `needs` a rule defined by another spec is a definition error. Rules are
  matched across a rebuild by name.
- Scenarios run in the variant too, as seeds. A scenario that fails in the variant (it relied
  on the rule) is dropped as a seed for that variant, and noted, rather than failing the check.

### Invariants

- The spec as written is unchanged by rules: every `rule.on` is `true`, so its states and
  verdicts are the same as before.
- `spec.without([])` builds a spec equal to the original.
- A variant is a spec like any other: every check, view and command works on it.

### Compatibility and migration

- Specs without rules are unchanged.
- The `sed` copies and `PENDING_RULE` constants agents write today become one `defineRule`,
  a `rule.on` read, and `needs` on the properties.

### Rollout and validation

1. DSL: `defineRule`, `needs` on properties, `Spec.rules` and `without`, and the
   definition-time checks.
2. Check: the rule verdicts, the early stop once every property that needs the rule broke,
   and `--json`. Tested on both engines.
3. CLI: the rules section, `--without` on `check`, `run` and `dev`, and `--as-scenario`.
4. Explorer: rules in the Checks panel, with each verdict.
5. One example (retried call) defines its idempotency key as a rule, alongside the existing
   factory, and the skill teaches rules.

## Drawbacks

- Every claimed rule costs another search on every check. The early stop keeps a ✓ cheap, but a
  ✗ or a ~ costs a full search. `--no-rules` skips them when iterating.
- Rules are read inside handlers, so the spec has branches that the code doesn't. That's
  already true of the `buggy`/`fixed` examples, and here the branch is named and described.
- It is easy to define a rule that no property needs. Then it's only a switch. That's fine,
  but the claim is the valuable part, so the skill should push for it.

## Rationale and alternatives

### Proposed design

Rules put the "what if we drop this?" question into the spec, where the check keeps
answering it. A rule is a value the author defines, reads where it applies, and points to
from the properties that need it. That's the smallest thing that replaces the `sed` copies
and makes the claim durable, with the type checker following every reference.

### A composite property

`readWaitsBehindPush: (w) => ackedPushesAreVisible(w) && readsNeverGoBack(w)` groups two
properties, but it's still a statement about the design as written: it holds, as both of its
parts do. A rule's claim is about a different design, the one without the rule: it says that
there, the property breaks. No property of one design can say that, however it's combined,
because the design without the rule never runs. That needs a second model, and that's what
`without` builds. TLA+ users do the same with a `Buggy` constant, as Feynman's own oracles
do.

Composite properties still help: a property that groups others can need a rule like any
other, and the claim then reads "without the pending rule, read consistency breaks".

### Property names as strings

A first draft declared rules in the spec's options, with `needed: ["ackedPushesAreVisible"]`.
The type checker could follow that only through string-literal types threaded from
`defineProperties` back to the options, and renaming a property would leave the claim behind
until the check ran. A reference from the property to the rule is checked as soon as it's
written. It also reads in the direction a reader asks: "what does this property depend on?".

### Simpler or narrower approach

- **Check named exports.** Have the CLI load `export const fixed` as well as the default,
  with `--export NAME`. It's simple, and covers the examples, but it doesn't say what the
  variant is for. A user would have to compare two reports by eye to see that a property
  broke, and nothing fails when it stops breaking.
- **Only `--without`, no `needs`.** It gets rid of the copies, but not the reason they are
  made: the claim would still live in a transcript.

### Other alternatives considered

- **Generic options** (`options: { pageSize: 2 }`). They're more general, but a check can't
  say what "needed" means for a number, and bounds and instances already vary the sizes.
- **Automatic mutation testing.** Drop each guard or transition in turn and see which
  properties notice. It needs no annotation, but most mutations are meaningless, and it can't
  tell an intended weak point from a dead rule. It could build on rules later.

### Do nothing

Agents keep copying specs to answer the question, and the answers are lost. Weak properties
stay unnoticed until a real bug walks past them.

## Prior art

- **Mutation testing** (PIT, Stryker, mutmut) changes the code and expects a test to fail; a
  surviving mutant points at a weak test. Rules are named mutations of a design.
- **TLA+ practice** checks a spec with an invariant removed, or a guard weakened, to see TLC
  find the expected bug. This is done by hand, in a copy of the module or with a constant in
  the `.cfg`, as the `Buggy` constant in Feynman's own oracles does.
- **Feature flags** in services turn behaviour on and off by name. Rules are the same idea
  for a model, with a check attached.

## Unresolved questions

### Before acceptance

- The name: `rules`, or `safeguards`, or `features`? "Rule" reads well in descriptions ("the
  pending rule") but may suggest validation.
- Should a ✗ fail the check, or warn? Failing makes the claim mean something. A warning is
  gentler while a design is in flux.

### During implementation

- Whether variants share the step cache with the spec. They run different code, so probably
  not, but a rule read only in a few transitions leaves most steps identical.
- How the explorer shows a variant: a toggle per rule in the playground, or variants only
  from the CLI at first.

### Out of scope

- Migrating the corpus examples to rules.
- Rules that depend on each other (a rule only meaningful when another is on).

## Future possibilities

- **Explaining a design by its rules.** The explorer could show, for each rule, the shortest
  counterexample without it: "this is what the pending rule prevents". That's the best
  explainer of a design there is.
- **Suggested rules.** Automatic mutations could propose rules: "removing this guard breaks
  `readsNeverGoBack`; name it?".
- **Diffs.** `feynman diff` could say when a change makes a rule no longer needed.
