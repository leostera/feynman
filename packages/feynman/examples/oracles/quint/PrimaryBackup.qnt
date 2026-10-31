// An independent model of examples/primary-backup.ts, in Quint, for Apalache. A client writes
// to a primary, which stores the write and replicates it to a backup; the client is
// acknowledged as the primary stores (buggy) or once the backup confirms (fixed). A fault
// loses a message, or restarts a server, which keeps what it stored: a restart only spends the
// budget. The network is a bag: a count of copies per kind. The harness sets BUGGY, FAULTS and
// REPEATS.
module PrimaryBackup {
  const BUGGY: bool
  const FAULTS: int
  const REPEATS: int

  type Message = Write | Replicate | Replicated | Ack
  pure val MESSAGES = Set(Write, Replicate, Replicated, Ack)

  var acked: int
  var primary: int
  var backup: int
  var acts: int
  var net: Message -> int
  var faults: int

  pure def send(bag: Message -> int, ms: Set[Message]): Message -> int = ms.fold(bag, (b, m) => b.setBy(m, n => n + 1))
  pure def take(bag: Message -> int, m: Message): Message -> int = bag.setBy(m, n => n - 1)

  action init = all { acked' = 0, primary' = 0, backup' = 0, acts' = 0, net' = MESSAGES.mapBy(_ => 0), faults' = 0 }

  action write = all {
    acts < REPEATS, acts' = acts + 1, net' = net.send(Set(Write)),
    acked' = acked, primary' = primary, backup' = backup, faults' = faults,
  }
  action deliver(m: Message): bool = all {
    net.get(m) > 0, acts' = acts, faults' = faults,
    match m {
      | Write => all { primary' = primary + 1, acked' = acked, backup' = backup, net' = net.take(m).send(if (BUGGY) Set(Ack, Replicate) else Set(Replicate)) }
      | Replicate => all { backup' = backup + 1, acked' = acked, primary' = primary, net' = net.take(m).send(if (BUGGY) Set() else Set(Replicated)) }
      | Replicated => all { acked' = acked, primary' = primary, backup' = backup, net' = net.take(m).send(Set(Ack)) }
      | Ack => all { acked' = acked + 1, primary' = primary, backup' = backup, net' = net.take(m) }
    },
  }
  action lose(m: Message): bool = all {
    faults < FAULTS, net.get(m) > 0, net' = net.take(m), faults' = faults + 1,
    acked' = acked, primary' = primary, backup' = backup, acts' = acts,
  }
  // Either server restarting changes nothing but the budget: their writes are durable.
  action restart = all {
    faults < FAULTS, faults' = faults + 1,
    acked' = acked, primary' = primary, backup' = backup, acts' = acts, net' = net,
  }
  action nothing = all { acked' = acked, primary' = primary, backup' = backup, acts' = acts, net' = net, faults' = faults }

  action step = any { write, restart, nothing, nondet m = MESSAGES.oneOf() any { deliver(m), lose(m) } }

  val ackedIsReplicated = acked <= backup
}
