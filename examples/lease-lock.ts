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
      const clients = spec.defineZone({ name: "Clients", description: "they stall, as a GC pause would", place: { column: 0, region: false } });
      const zone = spec.defineZone({ name: "Cluster", place: { column: 1, arrange: "row", region: true } });

      const LockServer = spec.defineActor({
        name: "Lock server",
        zone,
        singleton: true,
        initialState: () => ({ holder: null as string | null, token: 0 }),
        place: { order: 0 },
        look: { icon: "lock", status: (s) => (s.holder ? `leased to ${s.holder}, token ${s.token}` : "free"), mood: (s) => (s.holder ? "busy" : "ok") },
        transitions: {
          [Acquire]: {
            description: "Grants the lock unless someone else's lease is still running.",
            say: (s, _msg) => (s.holder ? `Leases the lock to ${s.holder}, with token ${s.token}` : "Turns the request down"),
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
        place: { order: 1 },
        look: {
          icon: "database",
          status: (s) => (s.accepted.length ? `${s.accepted.length} write(s)` : "empty"),
          mood: (s) => (s.accepted.every((t, i, all) => i === 0 || t >= all[i - 1]) ? "ok" : "bad"),
          rows: (s) => s.accepted.map((token, i) => ({ group: "writes, in order", label: `write ${i + 1}`, detail: `token ${token}` })),
        },
        transitions: {
          [Write]: {
            description: "Stores a write; with fencing, only from the newest token it has seen.",
            say: (s, msg) => (s.accepted.at(-1) === msg.token ? `Takes a write with token ${msg.token}` : `Refuses a write with token ${msg.token}: it has seen a newer one`),
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
        zone: clients,
        symmetric: true,
        initialState: () => ({ token: null as number | null, asking: false }),
        look: {
          icon: "laptop",
          status: (s) => (s.token !== null ? `holds token ${s.token}; stalled before writing` : s.asking ? "asking for the lock" : "idle"),
          mood: (s) => (s.token !== null ? "busy" : "off"),
        },
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

      spec.defineProperties({
        fenced: {
          description: "Storage never takes a write from an older lock holder after a newer one's.",
          always: (w) => w.the(Storage).state.accepted.every((token, i, all) => i === 0 || token >= all[i - 1]),
        },
      });
      spec.defineScenario({
        name: "One client writes",
        description: "Client A takes the lock and writes.",
        run(s) {
          const a = s.spawn(Client, "Client A");
          s.spawn(Client, "Client B");
          s.act(a, "acquire");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "A stalled holder wakes up",
        description:
          variant === "buggy"
            ? "A's lease runs out while it stalls; B takes the lock and writes; A wakes and writes over B."
            : "A's lease runs out while it stalls; B takes the lock and writes; A wakes, and storage refuses its older token.",
        run(s) {
          const a = s.spawn(Client, "Client A");
          const b = s.spawn(Client, "Client B");
          const server = s.the(LockServer);
          const storage = s.the(Storage);
          s.act(a, "acquire");
          s.deliver(server, "Acquire");
          s.deliver(a, "Granted");
          s.fire(server, "expire");
          s.act(b, "acquire");
          s.deliver(server, "Acquire");
          s.deliver(b, "Granted");
          s.fire(b, "write");
          s.deliver(storage, "Write");
          s.fire(a, "write");
          s.deliver(storage, "Write");
        },
      });
      return { LockServer, Storage, Client };
    },
  );
}

/** `feynman check lease-lock` checks the buggy variant, so you see the checker find the bug. */
export default leaseLock("buggy");
export const fixed = leaseLock("fixed");
