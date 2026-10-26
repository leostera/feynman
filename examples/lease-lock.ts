// A lock with a lease, and fencing tokens.
//
// Clients take a lock from a server for a one-second lease, then write to storage. A client
// can stall (a GC pause) between being granted the lock and writing, by which time its lease
// has run out and another client holds the lock. Without fencing, storage takes the stale
// write after the new holder's. With fencing, each grant carries a larger token and storage
// refuses a token smaller than one it has seen.
//
// There is no clock (RFD0004): the lease is an `expire` timer the server sets when it grants
// the lock, and the stall is the client's `write` timer. Either may fire first, which is the
// point: nothing makes a pause shorter than a lease.
//
// Expected, with two clients: buggy breaks `fenced` in 10 steps (A is granted the lock and
// stalls; once the lease is over B is granted it, stalls, and writes; then A's write lands);
// fixed holds.
import { defineSpec, message } from "@leostera/feynman";

export function leaseLock(variant: "buggy" | "fixed") {
  return defineSpec(
    `Lease lock (${variant})`,
    {
      messages: {
        Acquire: message<{}>({ name: "acquire" }),
        Granted: message<{ token: number }>({ name: "granted", tone: "reply" }),
        Denied: message<{}>({ name: "denied", tone: "refused" }),
        Write: message<{ token: number }>({ name: "write" }),
      },
    },
    (spec) => {
      const { Acquire, Granted, Denied, Write } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster" });

      const LockServer = spec.defineActor({
        name: "Lock server",
        zone,
        singleton: true,
        initialState: () => ({ holder: null as string | null, token: 0 }),
        transitions: {
          [Acquire]: {
            description: "Grants the lock unless someone else's lease is still running.",
            sends: [Granted, Denied],
            starts: ["expire"],
            run(state, _msg, ctx) {
              const asker = ctx.from!.id;
              if (state.holder && state.holder !== asker) return ctx.reply(Denied, {});
              state.holder = asker;
              state.token += 1;
              ctx.start("expire");
              ctx.reply(Granted, { token: state.token });
            },
          },
          expire: {
            description: "The lease runs out: the lock is free again.",
            after: "1 second",
            run(state) {
              state.holder = null;
            },
          },
        },
      });

      const Storage = spec.defineActor({
        name: "Storage",
        zone,
        singleton: true,
        initialState: () => ({ accepted: [] as number[] }),
        transitions: {
          [Write]: {
            description: "Stores a write; with fencing, only from the newest token it has seen.",
            run(state, msg) {
              const newest = Math.max(0, ...state.accepted);
              if (variant === "fixed" && msg.token < newest) return;
              state.accepted.push(msg.token);
            },
          },
        },
      });

      const Client = spec.defineActor({
        name: "Client",
        zone,
        symmetric: true,
        initialState: () => ({ token: null as number | null, asking: false }),
        actions: {
          acquire: {
            label: "Take the lock",
            description: "Asks the lock server for the lock.",
            when: (state) => state.token === null && !state.asking,
            sends: [Acquire],
            run(state, _inputs, ctx) {
              state.asking = true;
              ctx.send(ctx.the(LockServer), Acquire, {});
            },
          },
        },
        transitions: {
          [Granted]: {
            description: "Holds the lock, then stalls before writing.",
            starts: ["write"],
            run(state, msg, ctx) {
              state.asking = false;
              state.token = msg.token;
              ctx.start("write");
            },
          },
          [Denied]: { description: "Someone else holds it.", run: (state) => void (state.asking = false) },
          write: {
            description: "Wakes up and writes, believing it still holds the lock.",
            after: "2 seconds, a GC pause",
            sends: [Write],
            run(state, ctx) {
              if (state.token === null) return;
              ctx.send(ctx.the(Storage), Write, { token: state.token });
              state.token = null;
            },
          },
        },
      });

      spec.defineInvariants({
        fenced: {
          description: "Storage never takes a write from an older lock holder after a newer one's.",
          always: (w) => w.the(Storage).state.accepted.every((token, i, all) => i === 0 || token >= all[i - 1]),
        },
      });
      return { LockServer, Storage, Client };
    },
  );
}

/** `feynman check lease-lock` checks the buggy variant, so you see the checker find the bug. */
export default leaseLock("buggy");
export const fixed = leaseLock("fixed");
