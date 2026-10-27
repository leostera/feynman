// Primary–backup replication, acknowledging before replicating.
//
// A client writes to a primary, which keeps a backup in step so that it can take over. The
// primary stores the write, tells the client it succeeded, and sends it on to the backup.
// For a moment the client has been told the write is safe while only the primary has it: if
// the primary died then, the backup would take over without it. The fix: the primary tells
// the client only once the backup confirms it has the write too. A lost message then only
// leaves a write unacknowledged, never acknowledged and missing.
//
// This covers replies sent too early, before the step that makes them true. Both servers
// keep their writes on disk, so a restart loses nothing: the risk is the moment between
// the acknowledgement and the backup having the write.
//
// Expected: buggy breaks `ackedIsReplicated` in 3 steps without faults (write, the primary
// stores, acknowledges and replicates, the acknowledgement arrives first); fixed holds, with
// a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function primaryBackup(variant: "buggy" | "fixed") {
  return defineSpec(
    `Primary–backup (${variant})`,
    {
      messages: {
        Write: message<{}>({ name: "write" }),
        Ack: message<{}>({ name: "ack", tone: "reply" }),
        Replicate: message<{}>({ name: "replicate" }),
        Replicated: message<{}>({ name: "replicated", tone: "reply" }),
      },
    },
    (spec) => {
      const { Write, Ack, Replicate, Replicated } = spec.messages;
      const clients = spec.defineZone({ name: "Clients", place: { column: 0, region: false } });
      const zone = spec.defineZone({ name: "Cluster", description: "the backup takes over if the primary dies", place: { column: 1, arrange: "row", region: true } });

      const Client = spec.defineActor({
        name: "Client",
        zone: clients,
        singleton: true,
        initialState: () => ({ acked: 0 }),
        look: { icon: "laptop", status: (s) => (s.acked ? `told ${s.acked} write(s) succeeded` : "nothing acknowledged") },
        actions: {
          write: { label: "Write", description: "Writes to the primary.", sends: [Write], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Primary), Write, {}) },
        },
        transitions: { [Ack]: { description: "Is told the write succeeded.", run: (state) => void (state.acked += 1) } },
      });

      const Primary = spec.defineActor({
        name: "Primary",
        zone,
        place: { order: 0 },
        // Both servers keep what they store on disk: a restart loses nothing.
        durable: ["stored"],
        initialState: () => ({ stored: 0 }),
        look: { icon: "database", status: (s) => `${s.stored} write(s)`, mood: () => "ok" },
        transitions: {
          [Write]: {
            description: variant === "buggy" ? "Stores the write, acknowledges it, and replicates it." : "Stores the write and replicates it.",
            sends: variant === "buggy" ? [Ack, Replicate] : [Replicate],
            say: (s) => (variant === "buggy" ? `Stored write ${s.stored} and said it succeeded: only the primary has it` : `Stored write ${s.stored}; waits for the backup before saying so`),
            run(state, _msg, ctx) {
              state.stored += 1;
              if (variant === "buggy") ctx.send(ctx.the(Client), Ack, {});
              ctx.send(ctx.the(Backup), Replicate, {});
            },
          },
          [Replicated]: { description: "Acknowledges a write the backup has.", sends: [Ack], run: (_state, _msg, ctx) => ctx.send(ctx.the(Client), Ack, {}) },
        },
      });

      const Backup = spec.defineActor({
        name: "Backup",
        zone,
        place: { order: 1 },
        durable: ["stored"],
        initialState: () => ({ stored: 0 }),
        look: { icon: "database", status: (s) => `${s.stored} write(s)`, mood: () => "info" },
        transitions: {
          [Replicate]: {
            description: variant === "buggy" ? "Stores the write." : "Stores the write and confirms it.",
            sends: variant === "buggy" ? [] : [Replicated],
            run(state, _msg, ctx) {
              state.stored += 1;
              if (variant === "fixed") ctx.reply(Replicated, {});
            },
          },
        },
      });

      spec.defineInvariants({
        ackedIsReplicated: { description: "Every write the client was told succeeded is on the backup.", always: (w) => w.the(Client).state.acked <= w.the(Backup).state.stored },
      });
      spec.defineScenario({
        name: "A write",
        description: variant === "buggy" ? "The acknowledgement overtakes the replication: the client is told before the backup has the write." : "The client is told once the backup has the write.",
        run(s) {
          const client = s.the(Client);
          s.spawn(Primary, "Primary");
          s.spawn(Backup, "Backup");
          s.act(client, "write");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "The replication is lost",
        description: variant === "buggy" ? "The client was told the write succeeded; the backup never gets it." : "The backup never gets the write, so the client is never told it succeeded.",
        run(s) {
          const client = s.the(Client);
          const primary = s.spawn(Primary, "Primary");
          const backup = s.spawn(Backup, "Backup");
          s.act(client, "write");
          s.deliver(primary, "Write");
          s.drop(backup, "Replicate");
          s.settle();
        },
      });
      return { Client, Primary, Backup };
    },
  );
}

/** `feynman check primary-backup` checks the buggy variant, so you see the checker find the bug. */
export default primaryBackup("buggy");
export const fixed = primaryBackup("fixed");
