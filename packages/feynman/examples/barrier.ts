// A barrier: no worker goes on until every worker has arrived.
//
// Two workers each tell a coordinator when they reach the barrier; when it has heard from
// both, it lets them through. The bug: it counts arrivals, not workers. A worker that
// restarts forgets it has arrived, arrives again, and is counted twice: the barrier opens
// with the other worker still on its way. The fix: the coordinator keeps who has arrived.
//
// Expected, with two workers: buggy breaks `waitsForAll` in 5 steps with one fault (A
// arrives and is counted, A restarts and arrives again, and is counted again: the barrier
// opens); fixed holds, with a fault too. Both get stuck in 4 steps when an arrival is lost:
// nothing resends it, so the barrier never opens.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const Arrived = defineMessage("Arrived");
const Go = defineMessage("Go");

export function barrier(variant: "buggy" | "fixed") {
  const zone = defineZone({ name: "Job", description: "nobody goes on until everyone is here" });

  const Coordinator = defineActor({
    name: "Coordinator",
    zone,
    singleton: true,
    initialState: () => ({ count: 0, arrived: [] as string[], open: false }),
    display: {
      icon: "gear",
      status: (s) => (s.open ? "open" : `${variant === "buggy" ? s.count : s.arrived.length} arrival(s)`),
      mood: (s) => (s.open ? "ok" : "busy"),
      rows: (s) => s.arrived.map((id) => ({ label: id, detail: "here", mood: "ok" as const })),
    },
    transitions: {
      arrived: {
        on: Arrived,
        description: "Notes the arrival; once everyone is here, lets them all through.",
        say: (s) => (s.open ? "Everyone is here, it thinks: opens the barrier" : variant === "buggy" ? `Counts ${s.count} arrival(s)` : `${s.arrived.length} worker(s) here`),
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
      arrivedLost: lose(Arrived, { spend: faults }),
    },
  });

  const Worker = defineActor({
    name: "Worker",
    zone,
    // `reached` is what happened, which a restart cannot undo; `arrived` is what the worker remembers.
    initialState: () => ({ arrived: false, reached: false, through: false }),
    display: {
      icon: "cpu",
      status: (s) => (s.through ? "through" : s.arrived ? "waiting at the barrier" : s.reached ? "restarted" : "working"),
      mood: (s) => (s.through ? "ok" : s.arrived ? "busy" : "off"),
    },
    actions: {
      arrive: {
        with: [atMost(2)],
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
    transitions: {
      go: { on: Go, description: "Goes on past the barrier.", run: (state) => void (state.through = true) },
      goLost: lose(Go, { spend: faults }),
      crash: crash({ keeps: ["reached"], spend: faults }),
    },
  });

  const waitsForAll = defineProperty("waitsForAll", {
    description: "The barrier opens only once every worker has reached it.",
    always: (w) => !w.the(Coordinator).state.open || w.all(Worker).every((x) => x.state.reached),
  });

  const bothArrive = defineScenario("Both arrive", {
    description: "Both workers reach the barrier, and it lets them through.",
    run(s) {
      const workers = ["Worker A", "Worker B"].map((name) => s.spawn(Worker, name));
      for (const w of workers) s.act(w, "arrive");
      s.settle();
    },
  });

  const aWorkerRestarts = defineScenario("A worker restarts", {
    description:
      variant === "buggy"
        ? "Worker A arrives, restarts, and arrives again: two arrivals, so the barrier opens without Worker B."
        : "Worker A arrives, restarts, and arrives again: still one worker, so the barrier waits for Worker B.",
    run(s) {
      const [a] = ["Worker A", "Worker B"].map((name) => s.spawn(Worker, name));
      s.act(a, "arrive");
      s.settle();
      s.step(a, "crash");
      s.act(a, "arrive");
      s.settle();
    },
  });

  return defineSpec({
    name: `Barrier (${variant})`,
    actors: [Coordinator, Worker],
    properties: [waitsForAll],
    finalState: {
      description: "Every worker is through the barrier.",
      when: (w) => w.all(Worker).every((n) => n.state.through),
    },
    scenarios: [bothArrive, aWorkerRestarts],
  });
}

/** `feynman check barrier` checks the buggy variant, so you see the checker find the bug. */
export default barrier("buggy");
export const fixed = barrier("fixed");
