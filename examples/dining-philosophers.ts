// Dining philosophers: two philosophers, two forks, each needing both to eat.
//
// A philosopher takes one fork, then the other, eats, and puts both back. A fork held by
// someone else queues the request and hands the fork over when it comes back. If each
// philosopher starts with a different fork, each can hold one and wait for the other's:
// deadlock. The fix: both take the forks in the same order, so whoever holds the first
// fork can always get the second.
//
// This covers a property of the whole system's shape (who waits for whom), and requests
// that queue rather than fail.
//
// Expected: buggy breaks `noDeadlock` in 6 steps without faults (both get hungry, each
// first fork is granted, each grant lands: both hold one fork and wait for the other); fixed
// holds, with a lost message too. Both get stuck: buggy in 8 steps, once each queued request
// has landed; fixed when a grant is lost, in 5 (nothing resends it).
import { defineSpec, message } from "@leostera/feynman";

export function diningPhilosophers(variant: "buggy" | "fixed") {
  return defineSpec(
    `Dining philosophers (${variant})`,
    {
      messages: {
        Take: message<{}>({ name: "take" }),
        Granted: message<{}>({ name: "granted", tone: "reply" }),
        Release: message<{}>({ name: "release" }),
      },
    },
    (spec) => {
      const { Take, Granted, Release } = spec.messages;
      const zone = spec.defineZone({ name: "Table", description: "a fork between each pair of philosophers", place: { arrange: "ring" } });

      const fork = (name: string, order: number) =>
        spec.defineActor({
          name,
          zone,
          singleton: true,
          place: { order },
          initialState: () => ({ holder: null as string | null, queue: [] as string[] }),
          look: {
            icon: "lock",
            status: (s) => (s.holder ? `held by ${s.holder}${s.queue.length ? `, ${s.queue.join(", ")} waiting` : ""}` : "on the table"),
            mood: (s) => (s.holder ? (s.queue.length ? "warn" : "busy") : "off"),
          },
          transitions: {
            [Take]: {
              description: "Hands the fork over if it is free; otherwise queues the request.",
              sends: [Granted],
              run(state, _msg, ctx) {
                if (state.holder !== null) return void state.queue.push(ctx.from!.id);
                state.holder = ctx.from!.id;
                ctx.reply(Granted, {});
              },
            },
            [Release]: {
              description: "Takes the fork back, and hands it to whoever has waited longest.",
              sends: [Granted],
              run(state, _msg, ctx) {
                state.holder = state.queue.shift() ?? null;
                const next = [ctx.the(Plato), ctx.the(Kant)].find((p) => p.id === state.holder);
                if (next) ctx.send(next, Granted, {});
              },
            },
          },
        });
      const ForkOne = fork("Fork one", 1);
      const ForkTwo = fork("Fork two", 3);

      const philosopher = (name: string, order: [typeof ForkOne, typeof ForkOne], seat: number) =>
        spec.defineActor({
          name,
          zone,
          singleton: true,
          place: { order: seat },
          initialState: () => ({ phase: "thinking" as "thinking" | "first" | "second" | "eating", meals: 0 }),
          look: {
            icon: "person",
            status: (s) => ({ thinking: "thinking", first: "reaching for a fork", second: "holds one fork, waits for the other", eating: "eating" })[s.phase] + (s.meals ? ` · ${s.meals} meal(s)` : ""),
            mood: (s) => ({ thinking: "off", first: "busy", second: "warn", eating: "ok" })[s.phase] as "off" | "busy" | "warn" | "ok",
          },
          actions: {
            eat: {
              label: "Get hungry",
              description: "Reaches for the first fork.",
              when: (state) => state.phase === "thinking",
              sends: [Take],
              run(state, _inputs, ctx) {
                state.phase = "first";
                ctx.send(ctx.the(order[0]), Take, {});
              },
            },
            finish: {
              label: "Finish eating",
              description: "Puts both forks back.",
              when: (state) => state.phase === "eating",
              sends: [Release],
              run(state, _inputs, ctx) {
                state.phase = "thinking";
                state.meals += 1;
                for (const f of order) ctx.send(ctx.the(f), Release, {});
              },
            },
          },
          transitions: {
            [Granted]: {
              description: "Holds a fork: reaches for the second, or eats.",
              sends: [Take],
              run(state, _msg, ctx) {
                if (state.phase === "first") {
                  state.phase = "second";
                  ctx.send(ctx.the(order[1]), Take, {});
                } else if (state.phase === "second") state.phase = "eating";
              },
            },
          },
        });
      const Plato = philosopher("Plato", [ForkOne, ForkTwo], 0);
      const Kant = philosopher("Kant", variant === "buggy" ? [ForkTwo, ForkOne] : [ForkOne, ForkTwo], 2);

      spec.defineProperties({
        noDeadlock: {
          description: "Never does each philosopher hold one fork while waiting for the other's.",
          always: (w) => !(w.the(Plato).state.phase === "second" && w.the(Kant).state.phase === "second"),
        },
      });
      spec.defineScenario({
        name: "Plato eats",
        description: "Plato takes both forks, eats, and puts them back.",
        run(s) {
          s.act(s.the(Plato), "eat");
          s.settle();
          s.act(s.the(Plato), "finish");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "Both get hungry",
        description:
          variant === "buggy"
            ? "Plato takes fork one and Kant fork two; each waits for the other's: deadlock."
            : "Both reach for fork one first: Plato gets it and eats, and Kant waits his turn.",
        run(s) {
          s.act(s.the(Plato), "eat");
          s.act(s.the(Kant), "eat");
          s.settle();
        },
      });
      return { ForkOne, ForkTwo, Plato, Kant };
    },
  );
}

/** `feynman check dining-philosophers` checks the buggy variant, so you see the checker find the bug. */
export default diningPhilosophers("buggy");
export const fixed = diningPhilosophers("fixed");
