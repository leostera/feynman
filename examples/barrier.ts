// A barrier: no worker goes on until every worker has arrived.
//
// Two workers each tell a coordinator when they reach the barrier; when it has heard from
// both, it lets them through. The bug: it counts arrivals, not workers. A worker that
// restarts forgets it has arrived, arrives again, and is counted twice: the barrier opens
// with the other worker still on its way. The fix: the coordinator keeps who has arrived.
//
// Expected, with two workers: buggy breaks `waitsForAll` in 5 steps with one fault (A
// arrives and is counted, A restarts and arrives again, and is counted again: the barrier
// opens); fixed holds, with a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function barrier(variant: "buggy" | "fixed") {
  return defineSpec(
    `Barrier (${variant})`,
    {
      messages: {
        Arrived: message<{}>({ name: "arrived" }),
        Go: message<{}>({ name: "go" }),
      },
    },
    (spec) => {
      const { Arrived, Go } = spec.messages;
      const zone = spec.defineZone({ name: "Job" });

      const Coordinator = spec.defineActor({
        name: "Coordinator",
        zone,
        singleton: true,
        initialState: () => ({ count: 0, arrived: [] as string[], open: false }),
        transitions: {
          [Arrived]: {
            description: "Notes the arrival; once everyone is here, lets them all through.",
            sends: [Go],
            run(state, _msg, ctx) {
              if (state.open) return;
              if (variant === "buggy") state.count += 1;
              else if (!state.arrived.includes(ctx.from!.id)) state.arrived.push(ctx.from!.id);
              const here = variant === "buggy" ? state.count : state.arrived.length;
              if (here < ctx.all(Worker).length) return;
              state.open = true;
              for (const w of ctx.all(Worker)) ctx.send(w, Go, {});
            },
          },
        },
      });

      const Worker = spec.defineActor({
        name: "Worker",
        zone,
        // `reached` is what happened, which a restart cannot undo; `arrived` is what the worker remembers.
        durable: ["reached"],
        initialState: () => ({ arrived: false, reached: false, through: false }),
        actions: {
          arrive: {
            label: "Reach the barrier",
            description: "Tells the coordinator it is here.",
            when: (state) => !state.arrived,
            sends: [Arrived],
            run(state, _inputs, ctx) {
              state.arrived = true;
              state.reached = true;
              ctx.send(ctx.the(Coordinator), Arrived, {});
            },
          },
        },
        transitions: { [Go]: { description: "Goes on past the barrier.", run: (state) => void (state.through = true) } },
      });

      spec.defineInvariants({
        waitsForAll: {
          description: "The barrier opens only once every worker has reached it.",
          always: (w) => !w.the(Coordinator).state.open || w.all(Worker).every((x) => x.state.reached),
        },
      });
      return { Coordinator, Worker };
    },
  );
}

/** `feynman check barrier` checks the buggy variant, so you see the checker find the bug. */
export default barrier("buggy");
export const fixed = barrier("fixed");
