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
      const zone = spec.defineZone({ name: "Cluster" });

      const Client = spec.defineActor({
        name: "Client",
        zone,
        singleton: true,
        initialState: () => ({ acked: 0 }),
        actions: {
          write: { label: "Write", description: "Writes to the primary.", sends: [Write], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Primary), Write, {}) },
        },
        transitions: { [Ack]: { description: "Is told the write succeeded.", run: (state) => void (state.acked += 1) } },
      });

      const Primary = spec.defineActor({
        name: "Primary",
        zone,
        // Both servers keep what they store on disk: a restart loses nothing.
        durable: ["stored"],
        initialState: () => ({ stored: 0 }),
        transitions: {
          [Write]: {
            description: variant === "buggy" ? "Stores the write, acknowledges it, and replicates it." : "Stores the write and replicates it.",
            sends: variant === "buggy" ? [Ack, Replicate] : [Replicate],
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
        durable: ["stored"],
        initialState: () => ({ stored: 0 }),
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
      return { Client, Primary, Backup };
    },
  );
}

/** `feynman check primary-backup` checks the buggy variant, so you see the checker find the bug. */
export default primaryBackup("buggy");
export const fixed = primaryBackup("fixed");
