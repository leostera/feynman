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
      const zone = spec.defineZone({ name: "Queue" });

      const World = spec.defineActor({
        name: "Outside world",
        zone,
        singleton: true,
        initialState: () => ({ effects: 0 }),
        transitions: { [Effect]: { description: "Something happens out there: an email, a charge.", run: (state) => void (state.effects += 1) } },
      });

      const Worker = spec.defineActor({
        name: "Worker",
        zone,
        singleton: true,
        initialState: () => ({ inbox: [] as { id: string; from: string }[], done: [] as string[] }),
        transitions: {
          [Job]: { description: "Queues the job.", run: (state, msg, ctx) => void state.inbox.push({ id: msg.id, from: ctx.from!.id }) },
          work: {
            description: "Works on the next job in the inbox, and acknowledges it.",
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
      return { World, Worker, Broker };
    },
  );
}

/** `feynman check job-queue` checks the buggy variant, so you see the checker find the bug. */
export default jobQueue("buggy");
export const fixed = jobQueue("fixed");
