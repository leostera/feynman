// A consumer that remembers what it processed only in memory.
//
// A broker hands out a job, charging a customer, and redelivers it until it hears back, each
// time its timer fires: delivery is at least once. The consumer makes that exactly once
// in effect by remembering which jobs it has done and skipping them. But it keeps that memory
// in RAM: if it restarts after charging and before its acknowledgement gets through, the
// redelivered job looks new, and the customer is charged twice. The fix: remember what was
// processed durably, with the charge (in one transaction, in a real system).
//
// This covers at-least-once delivery, idempotency keys, and what a restart forgets.
//
// Expected: buggy holds without faults, and breaks `chargedOnce` in 5 steps with one (the job
// is charged, the timer fires, the consumer restarts, the copy arrives); fixed holds, with a
// fault too.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const JOBS = ["job-1"];

const Job = defineMessage("Job", { job: String });
const Done = defineMessage("Done", { job: String }, { tone: "reply" });

export function idempotentConsumer(variant: "buggy" | "fixed") {
  const queue = defineZone({ name: "Queue", description: "delivers each job at least once", place: { column: 0 } });
  const billing = defineZone({ name: "Billing", description: "charges a customer for each job", place: { column: 1, region: true } });

  const Broker = defineActor({
    name: "Broker",
    zone: queue,
    singleton: true,
    initialState: () => ({ published: 0, unacked: new Set<string>() }),
    display: {
      icon: "queue",
      status: (s) => (s.unacked.size ? `waiting on ${[...s.unacked].join(", ")}` : s.published ? "all done" : "idle"),
      mood: (s) => (s.unacked.size ? "busy" : s.published ? "ok" : "off"),
    },
    actions: {
      publish: {
        with: [atMost(2)],
        label: "Publish",
        description: "Hands the next job to the consumer, and keeps it until the consumer says it is done.",
        when: (state) => state.published < JOBS.length,
        sends: [Job],
        starts: ["redeliver"],
        run(state, _inputs, ctx) {
          const job = JOBS[state.published];
          state.published += 1;
          state.unacked.add(job);
          for (const consumer of ctx.all(Consumer)) ctx.send(consumer, Job, { job });
          ctx.start("redeliver");
        },
      },
    },
    transitions: {
      done: {
        on: Done,
        description: "Forgets the job; with nothing left, stops redelivering.",
        say: (_s, msg) => `${msg.job} is done`,
        run(state, msg, ctx) {
          state.unacked.delete(msg.job);
          if (!state.unacked.size) ctx.cancel("redeliver");
        },
      },
      redeliver: {
        description: "Hands every job not yet done to the consumer again.",
        after: "30 seconds",
        sends: [Job],
        starts: ["redeliver"],
        say: (s) => `Redelivers ${[...s.unacked].join(", ")}`,
        run(state, _, ctx) {
          if (!state.unacked.size) return;
          for (const job of [...state.unacked].sort()) for (const consumer of ctx.all(Consumer)) ctx.send(consumer, Job, { job });
          ctx.start("redeliver");
        },
      },
      doneLost: lose(Done, { spend: faults }),
    },
  });

  const Consumer = defineActor({
    name: "Consumer",
    zone: billing,
    // What it charged is the bank's record, which a restart does not touch; what it
    // processed is its own memory, durable only when fixed.
    initialState: () => ({ processed: new Set<string>(), charged: {} as Record<string, number> }),
    display: {
      icon: "card",
      status: (s) => `charged ${Object.values(s.charged).reduce((a, b) => a + b, 0)} time(s)`,
      mood: (s) => (Object.values(s.charged).some((n) => n > 1) ? "bad" : "ok"),
      rows: (s) => Object.entries(s.charged).map(([job, n]) => ({ group: "charges", label: job, detail: `${n}×`, mood: n > 1 ? "bad" : "ok" })),
    },
    transitions: {
      job: {
        on: Job,
        description: "Charges the customer for the job, unless it remembers doing so, and says it is done.",
        sends: [Done],
        say: (s, msg) => (s.charged[msg.job] > 1 ? `Charges for ${msg.job} again` : s.processed.has(msg.job) ? `Charges for ${msg.job}` : `Skips ${msg.job}: done already`),
        run(state, msg, ctx) {
          if (!state.processed.has(msg.job)) {
            state.processed.add(msg.job);
            state.charged = { ...state.charged, [msg.job]: (state.charged[msg.job] ?? 0) + 1 };
          }
          ctx.reply(Done, { job: msg.job });
        },
      },
      jobLost: lose(Job, { spend: faults }),
      crash: crash({ keeps: variant === "buggy" ? ["charged"] : ["charged", "processed"], spend: faults }),
    },
  });

  const chargedOnce = defineProperty("chargedOnce", {
    description: "No job is ever charged twice.",
    always: (w) => w.all(Consumer).every((c) => Object.values(c.state.charged).every((n) => n <= 1)),
  });

  const aJob = defineScenario("A job", {
    description: "The job is charged once and acknowledged; the broker stops redelivering.",
    run(s) {
      s.spawn(Consumer, "Consumer");
      s.act(s.the(Broker), "publish");
      s.settle();
    },
  });

  const aRestartBeforeTheAcknowledgement = defineScenario("A restart before the acknowledgement", {
    description:
      variant === "buggy"
        ? "The consumer charges for job-1, the broker redelivers, and the consumer restarts, forgetting it: the copy is charged again."
        : "The consumer charges for job-1, the broker redelivers, and the consumer restarts; it remembers job-1 and skips the copy.",
    run(s) {
      const consumer = s.spawn(Consumer, "Consumer");
      const broker = s.the(Broker);
      s.act(broker, "publish");
      s.deliver(consumer, Job);
      s.fire(broker, "redeliver");
      s.step(consumer, "crash");
      s.deliver(consumer, Job);
      s.settle();
    },
  });

  return defineSpec({
    name: `Idempotent consumer (${variant})`,
    actors: [Broker, Consumer],
    properties: [chargedOnce],
    finalState: {
      description: "Every job is published and acknowledged.",
      when: (w) => w.the(Broker).state.published === JOBS.length && w.the(Broker).state.unacked.size === 0,
    },
    scenarios: [aJob, aRestartBeforeTheAcknowledgement],
  });
}

/** `feynman check idempotent-consumer` checks the buggy variant, so you see the checker find the bug. */
export default idempotentConsumer("buggy");
export const fixed = idempotentConsumer("fixed");
