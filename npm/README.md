# @leostera/feynman

Executable specs of how a system behaves. A spec is one TypeScript file that models part of
a system as a deterministic, discrete-event program: its actors and their state, the
messages between them, the actions people take, the timers and limits, and the rules that
must always hold. Each step can name the code it stands for.

From one spec, Feynman derives:

- **a simulator**: add people and machines, press their buttons, watch each message travel,
  and go back to any moment;
- **a model checker**: every order of events within bounds, with lost messages and
  restarts, plus long random runs, and the shortest trace that breaks a rule;
- **flows** of every scenario, and how they change between commits;
- **links to the code** behind each step, with its call tree.

See it on a real system: https://feynman.leostera.dev/s/github.com/leostera/axo/

## Install

Feynman runs on [Bun](https://bun.sh) 1.3 or later.

```sh
bun add -d @leostera/feynman
```

## A spec

```ts
// specs/lease-lock.ts
import { defineSpec, message, SEC } from "@leostera/feynman";

export default defineSpec(
  "Lease lock",
  {
    messages: {
      Acquire: message<{}>({ name: "acquire" }),
      Granted: message<{ token: number }>({ name: "granted", tone: "reply" }),
    },
  },
  (spec) => {
    const { Acquire, Granted } = spec.messages;
    const zone = spec.defineZone({ name: "Cluster" });

    const Server = spec.defineActor({
      name: "Lock server",
      zone,
      singleton: true,
      initialState: () => ({ token: 0 }),
      transitions: {
        [Acquire]: {
          description: "Grants the lock with a larger token each time.",
          sends: [Granted],
          run(state, _msg, ctx) {
            state.token += 1;
            ctx.reply(Granted, { token: state.token });
          },
        },
      },
    });

    const Client = spec.defineActor({
      name: "Client",
      zone,
      symmetric: true,
      initialState: () => ({ token: null as number | null }),
      actions: {
        acquire: {
          label: "Take the lock",
          description: "Asks the server for the lock.",
          sends: [Acquire],
          run(_state, _inputs, ctx) {
            ctx.send(ctx.the(Server), Acquire, {});
          },
        },
      },
      transitions: {
        [Granted]: { description: "Holds the lock.", run: (state, msg) => void (state.token = msg.token) },
      },
    });

    spec.defineInvariants({
      oneHolder: {
        description: "Two clients never hold the same token.",
        always: (w) => {
          const tokens = w.all(Client).map((c) => c.state.token).filter((t) => t !== null);
          return new Set(tokens).size === tokens.length;
        },
      },
    });
    return { Server, Client };
  },
);
```

## Commands

```sh
bunx feynman check    # type-check, run the scenarios, explore, and judge every rule
bunx feynman run      # the scenarios' traces, as text
bunx feynman dev      # the simulator, reloading as the spec changes
bunx feynman build    # everything in one self-contained .feynman/index.html
bunx feynman diff --base main
```

`check` gives every rule one of four verdicts: `✗` broken (with the trace), `✓` holds in
every state within the bounds, `~` held in the states explored before a limit, and `?`
never tested.

## For agents

The package ships a skill, `skills/feynman/SKILL.md`, which teaches a coding agent to read
a codebase and write, check and maintain its specs. Pi loads it from the package;
for other agents, point them at https://feynman.leostera.dev/SKILL.md.

## What it imports

- `@leostera/feynman`: the DSL (`defineSpec`, `message`, `SEC`, `MIN`) and its types.
- `@leostera/feynman/play`: the kit for an optional `specs/<name>.play.tsx`, which gives the
  simulator its own look.
- `@leostera/feynman/config`: `defineConfig` for `feynman.config.ts`.
