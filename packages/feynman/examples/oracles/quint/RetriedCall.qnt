// An independent model of examples/retried-call.ts, in Quint, for Apalache. A client pays
// through a call to the bank and, when the call fails, sends the same charge again. The bank
// charges every charge (buggy), or once per payment (fixed). The network is a bag: a count of
// copies per message. A fault loses the charge or its answer, and either way the client is
// told its call failed; that failure is never lost. The harness sets BUGGY, FAULTS, REPEATS.
module RetriedCall {
  const BUGGY: bool
  const FAULTS: int
  const REPEATS: int

  type Message = Charge | Charged | Failed
  pure val MESSAGES = Set(Charge, Charged, Failed)

  var paying: bool
  var paid: bool
  var pays: int
  var charges: int
  var seen: bool
  var net: Message -> int
  var faults: int

  pure def send(bag: Message -> int, m: Message): Message -> int = bag.setBy(m, n => n + 1)
  pure def take(bag: Message -> int, m: Message): Message -> int = bag.setBy(m, n => n - 1)

  action init = all {
    paying' = false, paid' = false, pays' = 0, charges' = 0, seen' = false,
    net' = MESSAGES.mapBy(_ => 0), faults' = 0,
  }

  action pay = all {
    not(paying), not(paid), pays < REPEATS,
    paying' = true, pays' = pays + 1, net' = net.send(Charge),
    paid' = paid, charges' = charges, seen' = seen, faults' = faults,
  }

  // The bank charges, unless (fixed) it has charged this payment, and answers.
  action bankCharges = all {
    net.get(Charge) > 0,
    charges' = if (BUGGY or not(seen)) charges + 1 else charges,
    seen' = if (BUGGY) seen else true,
    net' = net.take(Charge).send(Charged),
    paying' = paying, paid' = paid, pays' = pays, faults' = faults,
  }

  action clientPaid = all {
    net.get(Charged) > 0,
    paying' = false, paid' = true, net' = net.take(Charged),
    pays' = pays, charges' = charges, seen' = seen, faults' = faults,
  }

  // The call threw: the client sends the same charge again.
  action clientRetries = all {
    net.get(Failed) > 0,
    net' = net.take(Failed).send(Charge),
    paying' = paying, paid' = paid, pays' = pays, charges' = charges, seen' = seen, faults' = faults,
  }

  // Losing the charge or its answer fails the call: the client hears of it.
  action lose(m: Message): bool = all {
    faults < FAULTS, net.get(m) > 0,
    net' = net.take(m).send(Failed), faults' = faults + 1,
    paying' = paying, paid' = paid, pays' = pays, charges' = charges, seen' = seen,
  }

  action nothing = all {
    paying' = paying, paid' = paid, pays' = pays, charges' = charges, seen' = seen, net' = net, faults' = faults,
  }

  action step = any { pay, bankCharges, clientPaid, clientRetries, lose(Charge), lose(Charged), nothing }

  val chargedOnce = charges <= 1
}
