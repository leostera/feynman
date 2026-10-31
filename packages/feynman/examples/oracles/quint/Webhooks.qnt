// An independent model of examples/webhooks.ts, in Quint, for Apalache. A provider sends two
// events, in order; the shop credits each, skipping the last event seen (buggy) or any event
// seen before (fixed). The network is a bag: a count of copies per event. A fault duplicates
// an event in flight or loses one. The harness sets BUGGY, FAULTS and REPEATS.
module Webhooks {
  const BUGGY: bool
  const FAULTS: int
  const REPEATS: int

  pure val EVENTS = List("evt-1", "evt-2")
  pure val AMOUNT = 10

  var sent: int
  var acts: int
  var balance: int
  var last: str
  var seen: Set[str]
  var net: str -> int
  var faults: int

  action init = all {
    sent' = 0, acts' = 0, balance' = 0, last' = "", seen' = Set(),
    net' = Set("evt-1", "evt-2").mapBy(_ => 0), faults' = 0,
  }

  action notify = all {
    sent < EVENTS.length(), acts < REPEATS,
    net' = net.setBy(EVENTS[sent], n => n + 1), sent' = sent + 1, acts' = acts + 1,
    balance' = balance, last' = last, seen' = seen, faults' = faults,
  }

  action credit(e: str): bool = all {
    net.get(e) > 0,
    net' = net.setBy(e, n => n - 1),
    val credits = if (BUGGY) last != e else not(seen.contains(e))
    all {
      balance' = if (credits) balance + AMOUNT else balance,
      last' = if (credits and BUGGY) e else last,
      seen' = if (credits and not(BUGGY)) seen.union(Set(e)) else seen,
    },
    sent' = sent, acts' = acts, faults' = faults,
  }

  // A fault: the network hands over one more copy, or one fewer.
  action fault(e: str, by: int): bool = all {
    faults < FAULTS, net.get(e) > 0,
    net' = net.setBy(e, n => n + by), faults' = faults + 1,
    sent' = sent, acts' = acts, balance' = balance, last' = last, seen' = seen,
  }

  action nothing = all { sent' = sent, acts' = acts, balance' = balance, last' = last, seen' = seen, net' = net, faults' = faults }

  action step = any {
    notify, nothing,
    nondet e = Set("evt-1", "evt-2").oneOf()
    any { credit(e), fault(e, 1), fault(e, -1) },
  }

  val creditedOnce = balance <= AMOUNT * sent
}
