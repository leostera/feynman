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
// before the first delivery lands, both deliveries land, both are worked); fixed holds, and
// every job is finished even when one message is lost.
import { defineSpec, message } from "@leostera/feynman";

export function jobQueue(variant: "buggy" | "fixed") {
  return defineSpec(
    `Job queue (${variant})`,
    {
      messages: {
        Job: message<{ id: string }>({ name: "job" }),
        Ack: message<{ id: string }>({ name: "ack" }),
        Effect: message<{ id: string }>({ name: "side effect" }),
      },
    },
    (spec) => {
      const { Job, Ack, Effect } = spec.messages;
      const zone = spec.defineZone({ name: "Queue", description: "at-least-once delivery", place: { arrange: "row" } });

      const World = spec.defineActor({
        name: "Outside world",
        zone,
        singleton: true,
        initialState: () => ({ effects: 0 }),
        place: { order: 2 },
        look: { icon: "mail", status: (s) => `${s.effects} email(s) sent`, mood: (s) => (s.effects ? "info" : "off") },
        transitions: { [Effect]: { description: "Something happens out there: an email, a charge.", run: (state) => void (state.effects += 1) } },
      });

      const Worker = spec.defineActor({
        name: "Worker",
        zone,
        singleton: true,
        initialState: () => ({ inbox: [] as { id: string; from: string }[], done: [] as string[] }),
        place: { order: 1 },
        look: {
          icon: "cpu",
          status: (s) => (s.inbox.length ? `${s.inbox.length} job(s) to do` : `${s.done.length} done`),
          mood: (s) => (s.inbox.length ? "busy" : "ok"),
          rows: (s) => [...s.inbox.map((j) => ({ group: "inbox", label: j.id, mood: "busy" as const })), ...s.done.map((id) => ({ group: "done", label: id, mood: "ok" as const }))],
        },
        transitions: {
          [Job]: { description: "Queues the job.", run: (state, msg, ctx) => void state.inbox.push({ id: msg.id, from: ctx.from!.id }) },
          work: {
            description: "Works on the next job in the inbox, and acknowledges it.",
            say: (s) => `Works on ${s.done.at(-1)}, and acknowledges it`,
            when: (state) => state.inbox.length > 0,
            sends: [Effect, Ack],
            run(state, ctx) {
              const job = state.inbox.shift()!;
              if (variant === "buggy" || !state.done.includes(job.id)) {
                ctx.send(ctx.the(World), Effect, { id: job.id });
                state.done.push(job.id);
              }
              ctx.send(ctx.the(Broker), Ack, { id: job.id });
            },
          },
        },
      });

      const Broker = spec.defineActor({
        name: "Broker",
        zone,
        singleton: true,
        initialState: () => ({ pending: null as string | null, enqueued: 0 }),
        place: { order: 0 },
        look: { icon: "queue", status: (s) => (s.pending ? `${s.pending} out, not acknowledged` : `${s.enqueued} job(s) enqueued`), mood: (s) => (s.pending ? "busy" : "ok") },
        actions: {
          enqueue: {
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
          [Ack]: {
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
            run(state, ctx) {
              if (!state.pending) return;
              ctx.send(ctx.the(Worker), Job, { id: state.pending });
              ctx.start("redeliver");
            },
          },
        },
      });

      spec.defineInvariants({
        doneOnce: {
          description: "No job has its side effect twice.",
          never: (trace) => trace.count((e) => e.is(Worker, "work") && e.sent(Effect)) > trace.count((e) => e.is(Broker, "enqueue")),
        },
        jobsFinish: {
          description: "A job handed out is eventually acknowledged.",
          after: (w) => w.the(Broker).state.pending !== null,
          eventually: (w) => w.the(Broker).state.pending === null,
        },
      });
      spec.defineScenario({
        name: "A job",
        description: "The broker hands a job to the worker, which does it and acknowledges it.",
        run(s) {
          s.act(s.the(Broker), "enqueue");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "Redelivered while working",
        description:
          variant === "buggy"
            ? "The visibility timeout fires before the acknowledgement arrives: the job comes back, and the worker sends the email twice."
            : "The visibility timeout fires before the acknowledgement arrives: the job comes back, and the worker, having done it, only acknowledges it.",
        run(s) {
          const worker = s.the(Worker);
          const broker = s.the(Broker);
          s.act(broker, "enqueue");
          s.deliver(worker, "Job");
          s.step(worker, "work");
          s.fire(broker, "redeliver");
          s.settle();
        },
      });
      return { World, Worker, Broker };
    },
  );
}

/** `feynman check job-queue` checks the buggy variant, so you see the checker find the bug. */
export default jobQueue("buggy");
export const fixed = jobQueue("fixed");
