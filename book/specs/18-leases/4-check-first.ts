// Chapter 18, step 4: the worker asks whether it still holds the lease before it writes.
//
// Expected: `lockIsFreed` holds, and `noStaleWrites` still breaks with no
// faults: the lease runs out after the answer, while the write is on its way.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, type Setup } from "@leostera/feynman";

/** At most one fault on any path. */
const faults = budget("faults", 1);

const Acquire = defineMessage("Acquire", {}, { name: "acquire the lock" });
const Granted = defineMessage("Granted", { token: Number }, { tone: "reply" });
const Busy = defineMessage("Busy", {}, { tone: "refused" });
const Check = defineMessage("Check", {}, { name: "is the lock still mine?" });
const StillYours = defineMessage("StillYours", {}, { name: "still yours", tone: "reply" });
const Lost = defineMessage("Lost", {}, { name: "lease lost", tone: "refused" });
const Release = defineMessage("Release", {}, { name: "release the lock" });
const Write = defineMessage("Write", { token: Number }, { name: "write the report" });
const Written = defineMessage("Written", {}, { tone: "reply" });

const workers = defineZone({ name: "Workers", description: "two copies of the report job", place: { column: 0 } });
const infra = defineZone({ name: "Infrastructure", place: { column: 1 } });

const LockService = defineActor({
  name: "Lock service",
  description: "Hands the lock to one worker at a time.",
  zone: infra,
  singleton: true,
  // `token` counts the grants: the n-th worker to get the lock gets token n.
  initialState: () => ({ holder: null as string | null, token: 0 }),
  display: { icon: "lock", status: (s) => (s.holder ? `held, token ${s.token}` : "free") },
  transitions: {
    acquire: {
      on: Acquire,
      description: "Grants the lock for 30 seconds if it is free; otherwise says it is busy.",
      sends: [Granted, Busy],
      starts: ["expire"],
      run(state, _msg, ctx) {
        if (state.holder !== null) return ctx.reply(Busy, {});
        state.holder = ctx.from.id;
        state.token += 1;
        ctx.reply(Granted, { token: state.token });
        ctx.start("expire");
      },
    },
    release: {
      on: Release,
      description: "Frees the lock, if the sender holds it.",
      run(state, _msg, ctx) {
        if (state.holder !== ctx.from.id) return;
        state.holder = null;
        ctx.cancel("expire");
      },
    },
    check: {
      on: Check,
      description: "Says whether the sender still holds the lock.",
      sends: [StillYours, Lost],
      run(state, _msg, ctx) {
        ctx.reply(state.holder === ctx.from.id ? StillYours : Lost, {});
      },
    },
    expire: {
      description: "The lease runs out: the lock is free again, whoever had it.",
      after: "30 seconds",
      run: (state) => void (state.holder = null),
    },
  },
});

const Storage = defineActor({
  name: "Storage",
  description: "Where the report is written.",
  zone: infra,
  singleton: true,
  // The token of each write it accepted, in order.
  initialState: () => ({ writes: [] as number[] }),
  display: { icon: "storage", status: (s) => `${s.writes.length} write(s)` },
  transitions: {
    write: {
      on: Write,
      description: "Writes the report, and says so.",
      sends: [Written],
      run(state, msg, ctx) {
        state.writes.push(msg.token);
        ctx.reply(Written, {});
      },
    },
  },
});

type Job = "idle" | "asking" | "holding" | "checking" | "writing" | "done";

const Worker = defineActor({
  name: "Worker",
  description: "A copy of the report job: takes the lock, writes, lets go.",
  zone: workers,
  symmetric: true,
  initialState: () => ({ job: "idle" as Job, token: 0 }),
  display: { icon: "cpu", names: ["Worker A", "Worker B"], status: (s) => (s.job === "holding" ? `holding token ${s.token}` : s.job) },
  actions: {
    start: {
      with: [atMost(2)],
      label: "Start the job",
      description: "Asks for the lock.",
      when: (s) => s.job === "idle",
      sends: [Acquire],
      run(state, _inputs, ctx) {
        state.job = "asking";
        ctx.send(ctx.the(LockService), Acquire, {});
      },
    },
  },
  transitions: {
    granted: {
      on: Granted,
      description: "Has the lock.",
      run(state, msg) {
        state.job = "holding";
        state.token = msg.token;
      },
    },
    busy: { on: Busy, description: "Someone else has the lock: tries again later.", run: (s) => void (s.job = "idle") },
    work: {
      description: "Before writing, makes sure the lease has not run out.",
      when: (s) => s.job === "holding",
      sends: [Check],
      run(state, _, ctx) {
        ctx.send(ctx.the(LockService), Check, {});
        state.job = "checking";
      },
    },
    stillYours: {
      on: StillYours,
      description: "The lease is still good: writes the report.",
      sends: [Write],
      run(state, _msg, ctx) {
        ctx.send(ctx.the(Storage), Write, { token: state.token });
        state.job = "writing";
      },
    },
    lost: { on: Lost, description: "The lease ran out: gives up, and starts again later.", run: (s) => void (s.job = "idle") },
    written: {
      on: Written,
      description: "The report is written: lets go of the lock.",
      sends: [Release],
      run(state, _msg, ctx) {
        ctx.send(ctx.the(LockService), Release, {});
        state.job = "done";
      },
    },
    crash: crash({ spend: faults }),
  },
});

const noStaleWrites = defineProperty("noStaleWrites", {
  description: "Storage never accepts a write from an older lock holder after a newer one's.",
  always: (w) => w.the(Storage).state.writes.every((token, i, all) => i === 0 || all[i - 1]! <= token),
});

const lockIsFreed = defineProperty("lockIsFreed", {
  description: "Whoever holds the lock, it is eventually free again.",
  leadsTo: {
    whenever: (w) => w.the(LockService).state.holder !== null,
    then: (w) => w.the(LockService).state.holder === null,
  },
});

/** Both workers, there from the start. */
const setup = (w: Setup) => {
  w.spawn(Worker, "Worker A");
  w.spawn(Worker, "Worker B");
};

const bothStart = defineScenario("Both start at once", {
  description: "Both workers ask for the lock; A gets it and writes, and B gets it after.",
  setup,
  run(s) {
    const [a, b] = s.all(Worker);
    s.act(a!, "start");
    s.act(b!, "start");
    s.settle({ until: (w) => w.the(LockService).state.holder !== null });
    s.settle();
  },
});

export default defineSpec({
  name: "Report job",
  description: "Two copies of a job, and a lock so only one writes at a time.",
  actors: [LockService, Storage, Worker],
  properties: [noStaleWrites, lockIsFreed],
  finalState: { description: "Nothing is in flight, and nobody holds the lock.", when: (w) => w.quiet && w.the(LockService).state.holder === null },
  scenarios: [bothStart],
});
