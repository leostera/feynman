# Feynman

**Understand how a system behaves, and what each change does to it.**

Code tells you what each part does. It rarely tells you what happens when the parts meet:
when a reply is lost, a lease runs out mid-write, or two people press the same button. Those
are the bugs that reach production, and the questions a newcomer cannot answer by reading.

A Feynman spec is one TypeScript file that writes the behaviour down as a program that runs:
the actors and their state, the messages between them, the actions people take, and the
rules that must always hold, each step anchored to the code it stands for. From that one
file you get:

- **A simulator.** Add people and machines, press the buttons they would, watch every message
  travel, lose one, and go back to any moment to try something else.
- **A model checker that says how sure it is.** It tries every order of events within bounds,
  with lost messages and restarts, then takes long random runs. A broken rule comes with the
  shortest trace that breaks it; a rule that held says whether every state was explored.
- **The flows of every scenario**, step by step, and how they change between commits.
- **The code behind each step**, with its call tree, and a warning when that code changes
  under the spec.

See it on a real system: [axo's remote access](https://feynman.leostera.dev/s/github.com/leostera/axo/),
where people pair Macs with a one-time code and open terminals on them through a relay.

## Start

Feynman runs on [Bun](https://bun.sh) 1.3 or later.

```sh
bun add -d @leostera/feynman
bunx feynman check    # type-check, run the scenarios, explore, and judge every rule
bunx feynman dev      # the simulator, reloading as the spec changes
bunx feynman build    # all of it in one self-contained .feynman/index.html
```

Specs live in `specs/*.ts` and import `@leostera/feynman`:

```ts
import { defineSpec, message } from "@leostera/feynman";

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

[`examples/`](examples/) has seven well-known systems (two-phase commit, leader election,
a lease lock, a cache, a job queue, payments, a switch), each with a real bug for the checker
to find and the fix beside it.

## Let your agent write it

Specs are meant to be written by coding agents and read by people. The package ships a skill,
[`skills/feynman/SKILL.md`](skills/feynman/SKILL.md), that teaches an agent to read a codebase,
model one behaviour, check it, and report what it found. Pi loads it from the package; other
agents can read it at https://feynman.leostera.dev/SKILL.md. A prompt to start from:

> Read https://feynman.leostera.dev/SKILL.md, then write a Feynman spec for how <the behaviour>
> works in this repository. Put it in specs/, and run `bunx feynman check` until every rule
> holds or you can show a real bug. Report what the spec covers and every verdict.

## Verdicts you can trust

Every rule gets one of four verdicts, and Feynman never rounds up:

- `✗` broken, with the trace, found by the search, a random run, or a scenario;
- `✓` holds in every state within the bounds, all of them explored;
- `~` held in the states explored, but a limit stopped the search first;
- `?` never tested: nothing reached the situation the rule is about.

The checker is tested against others. On the examples, it finds the same distinct states, the
same verdicts and counterexamples of the same length as TLA+'s TLC, and the same verdicts as
the P checker (`bun run oracles`).

## This repository

- `src/`: the DSL and engine (`spec`), the checker (`check`), sources and call trees
  (`code`), the CLI (`cli`), the playground kit (`play`), and the browser view (`view`).
- `examples/`: the example specs, and TLA+ and P models of them in `examples/oracles/`.
- `skills/feynman/`: the skill. `docs/rfds/`: the design, one decision at a time.
- `sites/feynman.leostera.dev/`: the website, and the simulators it publishes.

```sh
bun install
bun run test         # everything but the oracles
bun run typecheck
bun run feynman dev  # the examples in the simulator
npm publish          # builds the view, type-checks and tests first
```

Status: early. The DSL may still change between minor versions.
