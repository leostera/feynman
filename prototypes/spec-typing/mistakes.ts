// Mistakes an agent is likely to make. Each must be a type error: if one compiles,
// `tsc` reports its `@ts-expect-error` as unused.
import { defineSpec, message, SEC } from "./dsl.ts";

defineSpec(
  "Mistakes",
  {
    messages: {
      Ping: message<{ n: number }>({ name: "ping" }),
      Pong: message<{ n: number }>({ name: "pong", tone: "reply" }),
      Other: message<{ s: string }>({ name: "other" }),
    },
  },
  (spec) => {
    const { Ping, Pong, Other } = spec.messages;
    const zone = spec.defineZone({ name: "Zone" });

    const Server = spec.defineActor({
      name: "Server",
      zone,
      initialState: () => ({ seen: 0, names: [] as string[] }),
      transitions: {
        [Ping]: {
          description: "Answers a ping.",
          sources: ["src/server.ts#ping"],
          sends: [Pong],
          run(state, msg, ctx) {
            state.seen += msg.n;
            // @ts-expect-error 1. a state field that does not exist
            state.sen += 1;
            // @ts-expect-error 2. a payload field that does not exist
            void msg.m;
            // @ts-expect-error 3. the wrong payload type
            ctx.reply(Pong, { n: "one" });
            // @ts-expect-error 4. a message the transition does not declare in `sends`
            ctx.reply(Other, { s: "x" });
            ctx.reply(Pong, { n: msg.n });
          },
        },
        // @ts-expect-error 5. a message key that is not in the spec's messages
        ["message:Nope"]: {
          description: "Never.",
          sources: ["src/server.ts#nope"],
          run() {},
        },
        tick: {
          description: "An internal step.",
          sources: ["src/server.ts#tick"],
          sends: [Ping],
          when: (state) => state.seen > 0,
          run(state, ctx) {
            // @ts-expect-error 6. a state field that does not exist, in an internal transition
            state.names.push(state.seen);
            // @ts-expect-error 7. a message the internal transition does not declare
            ctx.send(ctx.the(Server), Other, { s: "x" });
            ctx.send(ctx.the(Server), Ping, { n: 1 });
          },
        },
      },
    });

    const Client = spec.defineActor({
      name: "Client",
      zone,
      initialState: (ctx) => ({ name: ctx.label, sent: 0 }),
      actions: {
        ping: {
          label: "Ping",
          description: "Pings the server.",
          inputs: {
            n: spec.defineInput(Number, { examples: () => [1, 2] }),
            // @ts-expect-error 8. examples of the wrong type for the input
            mode: spec.defineInput(["fast", "slow"], { examples: () => ["medium"] }),
            quiet: { type: Boolean },
          },
          sources: ["src/client.ts#ping"],
          sends: [Ping],
          run(state, { n, mode, quiet }, ctx) {
            const flag: boolean = quiet;
            void flag;
            state.sent += n;
            const exact: number = n; // a number input is a number, not string | number
            void exact;
            const fast: "fast" | "slow" = mode;
            void fast;
            // @ts-expect-error 9. an input used as the wrong type
            const s: string = n;
            void s;
            // @ts-expect-error 10. another actor's state, misspelled
            void ctx.the(Server).state.seeen;
            ctx.send(ctx.the(Server), Ping, { n });
            ctx.start("retry", SEC);
          },
        },
      },
    });

    // 17. Examples outside defineInput. The error is reported where it is. In a larger
    // actor it can also make `state` unknown in that actor's actions until it is fixed.
    spec.defineActor({
      name: "Noisy",
      zone,
      initialState: () => ({ loud: false }),
      actions: {
        shout: {
          label: "Shout",
          description: "Shouts.",
          // @ts-expect-error 17. examples outside defineInput
          inputs: { loud: { type: Boolean, examples: () => [true] } },
          sources: ["src/noisy.ts#shout"],
          run(state, { loud }) {
            state.loud = loud;
          },
        },
      },
    });

    spec.defineLimit({
      name: "A limit",
      value: 1,
      // @ts-expect-error 11. a source that is neither path#symbol nor path:start-end
      sources: ["src/limits.ts"],
    });

    spec.defineInvariants({
      seenIsPositive: {
        description: "The server never counts below zero.",
        // @ts-expect-error 12. a state field that does not exist, in an invariant
        always: (world) => world.the(Server).state.count >= 0,
      },
    });

    spec.defineScenario({
      name: "Mistakes in a scenario",
      run(s) {
        const client = s.spawn(Client, "c");
        s.act(client, "ping", { n: 1, mode: "fast", quiet: false });
        // @ts-expect-error 13. an action the actor does not have
        s.act(client, "pong");
        // @ts-expect-error 14. an input of the wrong type
        s.act(client, "ping", { n: "1", mode: "fast", quiet: false });
        // @ts-expect-error 15. a missing input
        s.act(client, "ping", { n: 1, quiet: false });
        // @ts-expect-error 16. an action whose inputs are missing entirely
        s.act(client, "ping");
      },
    });
  },
);
