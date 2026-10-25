# Typing prototype for RFD0002

Can TypeScript type the spec DSL that [RFD0002](../../docs/rfds/RFD0002-feynman-specs.md)
proposes? It needs to infer `state`, `msg`, `ctx`, and `inputs` without annotations, and
to reject the mistakes an agent is likely to make.

- `dsl.ts` holds the types, with stub implementations.
- `remote-access.ts` is the RFD's example. It compiles without a single type annotation
  in a transition or an action.
- `mistakes.ts` holds 17 mistakes, each marked `@ts-expect-error`. `tsc` fails if any of
  them compiles.

```console
$ ../../packages/model/node_modules/.bin/tsc -p .   # TypeScript 7.0.2, strict
```

## Findings

1. **Message-keyed transitions work: `[Redeem]: { run(state, msg, ctx) }`.**
   - A message's key is the string literal `"message:Redeem"`.
   - `defineActor` maps each key in `transitions` to its payload, through the spec's
     message registry.
   - Each transition's `sends` is inferred separately, so a `send` or `reply` of a
     message it doesn't declare is a type error.
2. **The registry has to be typed before the actors**, so messages are declared in
   `defineSpec`'s second argument and read back with
   `const { Redeem } = spec.messages`. Separate `spec.defineMessage` calls inside the
   body can't be typed: `spec`'s type is fixed before they run.
3. **Wrappers lose the state type.** `spec.defineTransition({ … })` and
   `spec.defineAction({ … })` inside `defineActor` give `state: unknown`. TypeScript
   checks the wrapper call before it has inferred the actor's state from
   `initialState`. **Transitions and actions must be plain objects.** `NoInfer` on the
   state keeps the transitions from widening it back to `unknown`.
4. **Inputs:** `{ type: String }` works as a plain object. Examples need a helper,
   `spec.defineInput(type, { examples })`, for two reasons:
   - Inside two levels of inferred mapped types (the actions, then the inputs), example
     values lose their literal types: `"fast"` becomes `string`.
   - In some actors, a plain `examples` function breaks the inference of `state`.

   The helper fixes the input's type before the actor is inferred. Writing `examples`
   outside the helper is a type error whose message says what to use.
5. **Agents can act on the errors.** Most read like "Property 'sen' does not exist…
   Did you mean 'seen'?". Where TypeScript would say `never`, the DSL turns the expected
   type into a message that says what to do:
   - "message:Nope is not one of this spec's messages";
   - "every action of this actor takes inputs (ping); pass them as the third argument".
6. **Gap: actions' `sends` aren't checked by the compiler.** Inference handles one
   per-key type per mapped type, and for actions that's used by `inputs`. The engine
   must reject an undeclared send at runtime, for actions and transitions alike.

## What changes in the RFD

- Messages are declared in `defineSpec`'s `messages` block, not with `spec.defineMessage`.
- Transitions and actions are plain objects. `spec.defineTransition` and
  `spec.defineAction` are dropped.
- Inputs are `{ type }`, or `spec.defineInput(type, { examples })`.
- The compiler rejects an undeclared send in a transition; for actions, the runtime does.
