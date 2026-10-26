# RFD0003 - Playgrounds: a presentation layer over specs

- Feature Name: `playgrounds`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-10-26`
- Updated: `2026-10-26`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

A spec stays the bare behavioural model: actors, messages, steps, invariants and
scenarios, which the checker runs. Next to it, an optional **playground** file
(`specs/<name>.play.tsx`) says how that model is presented. It can show the system at the
right level of abstraction, by grouping actors into one node that opens up. It can
replace how any actor, token, message or link is drawn with a render function, and add
domain panels such as a terminal. Its components can act on the model. Without a
playground file, a denser and quieter default presentation is used. That default is built
from the same components a playground file composes, so the two look like one product.

## Motivation

The hand-built axo playground explains remote access better than the playground Feynman
derives from a spec of the same system. Side by side, the differences are these:

- **Abstraction.** It shows "Axo relay" as one thing. The spec, rightly, models the
  Worker, the account Durable Object, the pairing index and Access separately, because
  the checker needs them. The derived view draws all four as unconnected circles, each
  with a status ("Worker · stateless", "1 code indexed"), and nothing happens inside them
  that a newcomer can follow.
- **Domain components.** Opening a Mac there gives a terminal window with commands to
  click; running `whoami` shows the command travel from Alice's phone through Access and
  the relay to Studio and back, and the output lands in the terminal. The derived view
  can only run the action from a menu, asks for a host, runs a fixed command, and shows
  the output nowhere.
- **Tokens.** There, the pairing code is a yellow ticket with the code and the minutes it
  has left; it disappears once used. The derived view shows a chip saying "pairing
  code", which stays after it is used.
- **Status.** There, a Mac is grey until paired, then green, with a dashed, moving link to
  the relay. The derived view rings a Mac with its owner's colour, which reads as "connected"
  before it is.
- **Density and form.** There, things are thin, small and varied: the relay's label sits
  inside its circle, devices are not circles, and the action bar is a thin strip of small
  buttons. The derived view is round everywhere, large, and over-labelled; it reads as
  generic, not as this system.

Presentation data on actors (`look`, `links`, `tokens`, `place`, RFD0002's follow-ups)
closed part of the gap, but data alone cannot express "this is a terminal" or "these
four actors are the relay". Every attempt to say more through data makes the vocabulary
larger without reaching what a few lines of component code say directly.

## Goals

- The spec stays free of presentation code; the checker, CLI, flows, diffs and
  reference never load a playground file.
- One spec can be shown at more than one level of abstraction, collapsed by default
  where a newcomer needs it, and opened on demand.
- Any actor, token, message or link can be drawn by a render function. The function
  receives typed state and can act on the model.
- Domain panels (a terminal, a Settings pane, a file list) can be attached to an
  instance, and they show what the model does.
- A default presentation that is good without a playground file: denser, thinner,
  quieter, and in the same visual language as the components.
- Agents can write playground files with a small component kit, and the result is
  checked like the spec is.

## Non-goals

- Placing nodes by hand. Layout stays computed; placement hints (RFD0002 follow-up)
  remain the way to steer it.
- Changing the spec language beyond the hooks this needs: typed handles and groups.
- Proposals ("try a proposed change" toggles). They stay deferred.
- Making flows, diffs or reference pages use custom render functions. They keep the
  default presentation in this RFD.

## Guide-level explanation

### Two files, two jobs

`specs/remote-access.ts` is the model, as today. It now returns its actors, so other
files can name them with their types:

```ts
export default defineSpec("Remote access", { messages }, (spec) => {
  const Person = spec.defineActor({ … });
  const Worker = spec.defineActor({ … });
  const Accounts = spec.defineActor({ … });
  const Index = spec.defineActor({ … });
  const Access = spec.defineActor({ … });
  const AxoApp = spec.defineActor({ … });
  const Axod = spec.defineActor({ … });
  // …invariants, scenarios…
  return { Person, Worker, Accounts, Index, Access, AxoApp, Axod };
});
```

`specs/remote-access.play.tsx` is how it is shown:

```tsx
import { definePlayground, Node, Ticket, Terminal, Rows, countdown } from "@feynman/play";
import spec from "./remote-access.ts";

export default definePlayground(spec, (play) => {
  const { Person, Worker, Accounts, Index, Access, AxoApp, Axod } = spec.actors;

  // One thing on the map, four in the model. Click it to see inside.
  play.group("Axo relay", [Access, Worker, Accounts, Index], {
    icon: "cloud",
    collapsed: true,
    // What the group shows while collapsed: its own rows, from its members' state.
    render: ({ the }) => (
      <Node shape="circle" label="Axo relay" inside>
        <Rows rows={accountsOf(the(Accounts).state)} />
      </Node>
    ),
  });

  // One Mac on the map: the app and its daemon, drawn as one device.
  play.group("Mac", [AxoApp, Axod], { by: (i) => macName(i.label), shape: "device" });

  play.actor(Person, {
    node: ({ instance, state }) => <Node shape="device" icon="phone" label={instance.label} status={state.signedIn ? null : "signed out"} />,
    // Attached to the node while a session is open: a terminal to type in.
    panel: ({ state, act }) =>
      state.session && (
        <Terminal
          title={state.session.host}
          lines={state.outputs.map((o) => o.text)}
          commands={["whoami", "uptime", "ls ~"]}
          onRun={(command) => act("run", { host: state.session.host, command })}
        />
      ),
  });

  // The pairing code is a ticket with its code and time left; it goes when used.
  play.token("pairing code", ({ token, clock }) => <Ticket code={String(token.value)} left={countdown(token.expires, clock)} />);

  play.link("socket", { style: "dashed", flowing: true });
});
```

A person reading the playground sees: Alice's phone, the Axo relay, a Mac. They pair:
the relay shows "1 code waiting" and Alice's phone holds a ticket with the code and
9:58 left. They drag it to the Mac; it turns green and a dashed, moving link appears to
the relay. They open the Mac from Alice's phone; a terminal attaches to the phone. They
click `whoami`; the message travels phone → relay → Mac and back, and the output lands
in the terminal. Clicking the relay opens it to show Access, the Worker, the account
Durable Object and the pairing index, with the same messages now travelling between
them.

### Without a playground file

The default presentation is what a playground file starts from. It changes, in response
to the comparison above:

- **Smaller and denser:** 12px labels, 11px detail, thin 1.5px rings and lines, small
  nodes (48px), no status line unless the spec gives one, and statuses kept to two or
  three words.
- **Shape by kind, not circles everywhere.** Services are circles with their label
  inside; devices are rounded rectangles; stores are cards. The kind comes from
  the icon (`cloud`, `server`, `database` are services; `phone`, `laptop`, `browser` are
  devices), and `look.shape` overrides it.
- **Rings show status only:** grey until something is `ok` or `busy`. Identity, meaning whose
  it is, is a small coloured badge with the owner's initial, not the ring.
- **Live links are dashed and moving.** Static topology wires go.
- **The action bar is a thin strip of small buttons** beside the node, not a menu, with
  inputs in a small popover.
- **Tokens are tickets** showing their value and, if they carry `expires`, the time left.
  Tokens come from state, so a used code that the state drops is gone.
- **Groups declared in the spec** (see below) collapse by default when they hold more than
  two actors.

### Groups

Levels of abstraction are a property of the model, not only of one playground, so they
are declared in the spec, as data, and every view can use them:

```ts
const relay = spec.defineGroup({ name: "Axo relay", actors: [Access, Worker, Accounts, Index] });
```

A playground may add groups, override how a group renders, or choose what starts
collapsed. A collapsed group is one node. Messages between its members are internal:
they do not travel on the map, and they fold in the timeline under the group, like
routine steps, with an "open" affordance. Messages that cross its boundary attach to the
group node. An opened group is drawn as a region with its members inside, as zones are
now.

## Reference-level explanation

### Architecture and boundaries

- **`@feynman/spec`**:
  - `defineSpec`'s body may return its actor handles, which become `spec.actors` with
    their types.
  - `spec.defineGroup` records groups as data.
  - Nothing else changes; no React anywhere.
- **`@feynman/play`** (new package), the component kit and the `definePlayground`
  builder:
  - The components are `Node`, `Ticket`, `Terminal`, `Rows`, `Card`, `Badge`, `Panel`,
    `ActionBar` and `Link` styles.
  - It depends on React and Kumo.
  - The view's default presentation is built from these same components.
- **`@feynman/view`** loads a spec's playground file if there is one, and otherwise uses the
  default presentation. It owns layout, time, the timeline, menus, drag and drop, and
  dialogs; render functions only draw.
- **`@feynman/cli`**:
  - Discovery pairs `specs/<name>.ts` with `specs/<name>.play.tsx`.
  - `prepare` bundles the playground for the browser, with `react`, `@cloudflare/kumo` and
    `@feynman/play` aliased to the view's copies, so a repository installs nothing.
  - `check` type-checks the playground file along with the spec, but never runs it.

### Data model and interfaces

```ts
// @feynman/spec
defineSpec<M, H extends Record<string, Actor<any, any>>>(name, options, body: (spec) => H | void): Spec & { actors: H };
spec.defineGroup(def: { name: string; actors: Actor[]; description?: string }): Group;

// @feynman/play
definePlayground<S extends Spec & { actors: Record<string, Actor> }>(spec: S, body: (play: PlayBuilder<S>) => void): Playground;

interface PlayBuilder<S> {
  group(name: string, actors: Actor[], options?: { collapsed?: boolean; by?: (instance: InstanceView) => string; icon?: Icon; shape?: Shape; render?: (props: GroupProps) => ReactNode }): void;
  actor<A extends Actor>(actor: A, options: { node?: (props: NodeProps<A>) => ReactNode; panel?: (props: NodeProps<A>) => ReactNode; actions?: ActionStyle<A> }): void;
  token(kind: string, render: (props: TokenProps) => ReactNode): void;
  message(key: MessageKey, options: { chip?: (props: MessageProps) => ReactNode }): void;
  link(kind: string, style: { style?: "solid" | "dashed" | "dotted"; flowing?: boolean; color?: "owner" | Mood }): void;
}

interface NodeProps<A> {
  instance: { id: string; label: string };
  state: Readonly<StateOf<A>>;     // typed from the actor
  look: Appearance;                // the default look, to build on
  world: WorldView;                // the(Actor), all(Actor)
  clock: number;
  /** Run one of this instance's actions, as the action bar would. */
  act: <K extends ActionKeys<A>>(key: K, inputs?: InputsOf<A, K>) => void;
  live: boolean;                   // false while looking at the past
}
```

`Token` gains an optional `expires` (simulated milliseconds) for countdowns.

`look.shape` (`"circle" | "device" | "card"`) joins the presentation data on actors.

### Lifecycle and failure semantics

- **Render functions are pure** functions of their props. They run on every frame while
  time runs, so they must be cheap.
- **A render function that throws** falls back to the default presentation for that
  thing, with a small warning badge on it in the playground; the error is shown in the
  console and by `feynman check` when it can be found statically.
- **`act` runs through the same path as the action bar:** the session records the
  operation, the clock and time travel apply, and acting in the past branches from
  there. Acting while previewing a moment does nothing.
- **Groups.** A group's member that is not singleton is grouped per `by` key, so each Mac
  is one node. Members missing from a world simply do not appear.

### Invariants

- The checker's results do not depend on whether a playground file exists.
- A playground cannot change state except through `act`, which runs declared actions.
- Removing a playground file leaves a working default presentation.
- Every message still appears in the timeline, folded when internal to a collapsed
  group or routine.

### Compatibility and migration

- Specs that do not return handles keep working, but a playground file can only name
  their actors after they do.
- `look`, `links`, `tokens`, `place` and `routine` keep their meaning. A playground file
  overrides them; it does not replace them.
- The dropdown node menu becomes a thin action bar; there is no option to keep the menu.

### Security, privacy, and observability

Playground files are code from the repository being explained, run in the reader's
browser, as specs already are. Published sites run them too. No new trust boundary; the
same rule applies: only build sites from repositories you trust.

### Rollout and validation

1. Redesign the default presentation:
   - shapes by kind, density, status-only rings with identity badges;
   - flowing dashed links, the thin action bar;
   - tickets with countdowns.

   Validate against the hand-built axo playground with the Impeccable audit, aiming for
   16/20 or better.
2. Typed handles from `defineSpec`, and `spec.defineGroup` with collapsing, internal
   messages and timeline folding.
3. `@feynman/play`, playground discovery and bundling, and `act` in props.
4. Write `remote-access.play.tsx` for the axo test bed: a relay group, Macs as one
   device, a terminal panel, and tickets. Validate by walking the hand-built playground's
   flow end to end: sign in, pair, drag the code, see it go green, open the Mac, run
   `whoami`, see the output.
5. The skill teaches playground files: when to write one, the kit, and the rule that
   render functions only draw and act.

## Drawbacks

- Agents writing UI code. The reason RFD0002 forbade it was quality. The kit and the
  default presentation are the mitigation: agents compose designed components rather
  than style from scratch. The Impeccable detector runs on the built page.
- Two files per explainer to keep in step. Typed handles catch renamed actors and
  actions; nothing catches a render that silently stops making sense.
- React and Kumo become part of Feynman's public surface through `@feynman/play`.

## Rationale and alternatives

### Proposed design

It keeps the model honest and checkable, lets presentation be as specific as the
domain needs, and gives the default and the custom path one visual language. Groups in
the spec give every view abstraction levels, not only the playground.

### Simpler or narrower approach

Data blocks: `look.render(state)` returning a tree of a fixed set of blocks such as
terminal, ticket and card, with no React. It renders everywhere and agents cannot style
badly. It was the earlier proposal. It covers tickets and terminals, but interaction
(command buttons that act) and group renders need callbacks, and each new need grows the
block vocabulary. It could still be the serialisable form flows and diffs use later.

### Other alternatives considered

- **React render functions inside the spec:** one file, but the checker and CLI would
  import React, and presentation would be mixed into the model the checker trusts.
- **Hand-built playgrounds that import the spec's engine:** total freedom, but every
  explainer rebuilds time, the timeline, drag and drop and layout, and drifts from the
  default.

### Do nothing

The derived playground keeps looking generic, and the best explainers keep being
hand-built, disconnected from the spec and the checker.

## Prior art

- The hand-built axo playground, `docs/explainers/remote-access`: the target experience.
- Storybook's split between components and stories: presentation next to, not inside,
  the thing presented.
- C4's levels (context, container, component): one model, several zoom levels.
- Slack Block Kit: data blocks, the narrower alternative above.

## Unresolved questions

### Before acceptance

- Should groups live in the spec (as proposed) or only in playground files?
- Should a playground file be allowed to hide actors entirely, or only group them?
- Is `look.shape` enough for the default, or should kind be its own field?

### During implementation

- How internal messages of a collapsed group animate, if at all: a pulse on the group node?
- How panels lay out when several are open: attached to their node, or docked?
- Whether `feynman check` should screenshot the default and custom playgrounds and run
  the detector.

### Out of scope

- Render functions in flows, diffs and reference pages.
- Proposals.

## Future possibilities

- The same `play` hooks driving a guided tour: steps that act and narrate.
- Data blocks as the serialisable form of custom renders, so flows and diffs can show them.
- Group-level invariants and flows, such as "the relay as a whole never stores a code".
