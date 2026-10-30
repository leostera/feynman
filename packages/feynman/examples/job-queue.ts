// A job queue that redelivers a job until the worker acknowledges it.
//
// The broker hands a job to a worker and, if no acknowledgement comes within a second (the
// visibility timeout), hands it over again. The worker queues what it receives and works
// through its inbox (a guarded transition). Without remembering which jobs it has done, a
// redelivery that crosses a slow first delivery makes the worker do the job twice. The fix:
// the worker remembers done jobs and only acknowledges a repeat.
//
// This covers `never` properties over the trace, and guarded transitions.
//
// Expected: buggy breaks `doneOnce` in 6 steps without faults (enqueue, the timeout fires
// before the first delivery lands, both deliveries land, both are worked); fixed holds.
// `jobsFinish` is unfinished: every redelivery adds a copy in flight, so the worlds never
// run out, and a loop that never acknowledges could lie past any depth.
import { atMost, budget, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineVariable, defineZone, lose } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);
/** Times one instance takes each action on one path. */
const repeats = defineVariable("repeats", 2);

const Job = defineMessage("Job", { id: String });
const Ack = defineMessage("Ack", { id: String });
const Effect = defineMessage("Effect", { id: String }, { name: "side effect" });

export function jobQueue(variant: "buggy" | "fixed") {
  const zone = defineZone({ name: "Queue", description: "at-least-once delivery", place: { arrange: "row" } });

  const World = defineActor({
    name: "Outside world",
    zone,
    singleton: true,
    initialState: () => ({ effects: 0 }),
    place: { order: 2 },
    display: { icon: "mail", status: (s) => `${s.effects} email(s) sent`, mood: (s) => (s.effects ? "info" : "off") },
    transitions: {
      effect: { on: Effect, description: "Something happens out there: an email, a charge.", run: (state) => void (state.effects += 1) },
      effectLost: lose(Effect, { spend: faults }),
    },
  });

  const Worker = defineActor({
    name: "Worker",
    zone,
    singleton: true,
    initialState: () => ({ inbox: [] as { id: string; from: string }[], done: [] as string[] }),
    place: { order: 1 },
    display: {
      icon: "cpu",
      status: (s) => (s.inbox.length ? `${s.inbox.length} job(s) to do` : `${s.done.length} done`),
      mood: (s) => (s.inbox.length ? "busy" : "ok"),
      rows: (s) => [...s.inbox.map((j) => ({ group: "inbox", label: j.id, mood: "busy" as const })), ...s.done.map((id) => ({ group: "done", label: id, mood: "ok" as const }))],
    },
    transitions: {
      job: { on: Job, description: "Queues the job.", run: (state, msg, ctx) => void state.inbox.push({ id: msg.id, from: ctx.from!.id }) },
      work: {
        description: "Works on the next job in the inbox, and acknowledges it.",
        say: (s) => `Works on ${s.done.at(-1)}, and acknowledges it`,
        when: (state) => state.inbox.length > 0,
        sends: [Effect, Ack],
        run(state, _, ctx) {
          const job = state.inbox.shift()!;
          if (variant === "buggy" || !state.done.includes(job.id)) {
            ctx.send(ctx.the(World), Effect, { id: job.id });
            state.done.push(job.id);
          }
          ctx.send(ctx.the(Broker), Ack, { id: job.id });
        },
      },
      jobLost: lose(Job, { spend: faults }),
    },
  });

  const Broker = defineActor({
    name: "Broker",
    zone,
    singleton: true,
    initialState: () => ({ pending: null as string | null, enqueued: 0 }),
    place: { order: 0 },
    display: { icon: "queue", status: (s) => (s.pending ? `${s.pending} out, not acknowledged` : `${s.enqueued} job(s) enqueued`), mood: (s) => (s.pending ? "busy" : "ok") },
    actions: {
      enqueue: {
        with: [atMost(repeats)],
        label: "Enqueue",
        description: "Hands a new job to the worker.",
        when: (state) => state.pending === null,
        sends: [Job],
        starts: ["redeliver"],
        run(state, _inputs, ctx) {
          state.enqueued += 1;
          state.pending = ctx.fresh("job");
          ctx.send(ctx.the(Worker), Job, { id: state.pending });
          ctx.start("redeliver");
        },
      },
    },
    transitions: {
      ack: {
        on: Ack,
        description: "The job is done.",
        run(state, msg, ctx) {
          if (state.pending !== msg.id) return;
          state.pending = null;
          ctx.cancel("redeliver");
        },
      },
      redeliver: {
        description: "No acknowledgement in time: hand the job over again.",
        after: "1 second, the visibility timeout",
        sends: [Job],
        starts: ["redeliver"],
        run(state, _, ctx) {
          if (!state.pending) return;
          ctx.send(ctx.the(Worker), Job, { id: state.pending });
          ctx.start("redeliver");
        },
      },
      ackLost: lose(Ack, { spend: faults }),
    },
  });

  const doneOnce = defineProperty("doneOnce", {
    description: "No job has its side effect twice.",
    never: (trace) => trace.count((e) => e.is(Worker, "work") && e.sent(Effect)) > trace.count((e) => e.is(Broker, "enqueue")),
  });

  const jobsFinish = defineProperty("jobsFinish", {
    description: "A job handed out is eventually acknowledged.",
    leadsTo: { whenever: (w) => w.the(Broker).state.pending !== null, then: (w) => w.the(Broker).state.pending === null },
  });

  const aJob = defineScenario("A job", {
    description: "The broker hands a job to the worker, which does it and acknowledges it.",
    run(s) {
      s.act(s.the(Broker), "enqueue");
      s.settle();
    },
  });

  const redeliveredWhileWorking = defineScenario("Redelivered while working", {
    description:
      variant === "buggy"
        ? "The visibility timeout fires before the acknowledgement arrives: the job comes back, and the worker sends the email twice."
        : "The visibility timeout fires before the acknowledgement arrives: the job comes back, and the worker, having done it, only acknowledges it.",
    run(s) {
      const worker = s.the(Worker);
      const broker = s.the(Broker);
      s.act(broker, "enqueue");
      s.deliver(worker, Job);
      s.step(worker, "work");
      s.fire(broker, "redeliver");
      s.settle();
    },
  });

  return defineSpec({
    name: `Job queue (${variant})`,
    actors: [World, Worker, Broker],
    properties: [doneOnce, jobsFinish],
    scenarios: [aJob, redeliveredWhileWorking],
  });
}

/** `feynman check job-queue` checks the buggy variant, so you see the checker find the bug. */
export default jobQueue("buggy");
export const fixed = jobQueue("fixed");
