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
