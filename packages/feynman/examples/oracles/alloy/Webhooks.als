module Webhooks
-- An independent model of examples/webhooks.ts, for Alloy 6. A provider sends two events, in
-- order; the shop credits each, skipping the last event it saw (buggy) or any event it saw
-- before (fixed). The network is a bag: a count of copies per event. A fault duplicates an
-- event in flight (one more copy) or loses one. Both are singletons and neither restarts.
-- Notifying happens at most Repeats times. The balance counts credits, not money: each is the
-- same amount, and Alloy's integers are small. The harness appends Buggy, Faults and Repeats.

abstract sig Event { index: one Int }
one sig E1, E2 extends Event {}
fact order { E1.index = 0 and E2.index = 1 }

one sig W {
  var sent, acts, balance, faults: one Int,
  var last: lone Event,
  var seen: set Event,
  var net: Event -> one Int
}

pred init { W.sent = 0 and W.acts = 0 and W.balance = 0 and W.faults = 0 and no W.last and no W.seen and (all e: Event | W.net[e] = 0) }

-- The network after one more copy of e (by +1) or one fewer (by -1).
pred moves[e: Event, by: Int] { all x: Event | W.net'[x] = (x = e implies plus[W.net[x], by] else W.net[x]) }

pred keepShop { W.balance' = W.balance and W.last' = W.last and W.seen' = W.seen }

pred notify {
  W.sent < 2 and W.acts < Repeats
  moves[{ e: Event | e.index = W.sent }, 1]
  W.sent' = plus[W.sent, 1] and W.acts' = plus[W.acts, 1]
  keepShop and W.faults' = W.faults
}

pred credit[e: Event] {
  W.net[e] > 0 and moves[e, -1]
  Buggy implies {
    W.seen' = W.seen
    W.last = e implies { W.balance' = W.balance and W.last' = W.last }
    else { W.balance' = plus[W.balance, 1] and W.last' = e }
  } else {
    W.last' = W.last
    e in W.seen implies { W.balance' = W.balance and W.seen' = W.seen }
    else { W.balance' = plus[W.balance, 1] and W.seen' = W.seen + e }
  }
  W.sent' = W.sent and W.acts' = W.acts and W.faults' = W.faults
}

pred spend { W.faults < Faults and W.faults' = plus[W.faults, 1] }

pred duplicate[e: Event] { spend and W.net[e] > 0 and moves[e, 1] and keepShop and W.sent' = W.sent and W.acts' = W.acts }
pred lose[e: Event] { spend and W.net[e] > 0 and moves[e, -1] and keepShop and W.sent' = W.sent and W.acts' = W.acts }

pred nothing { keepShop and W.sent' = W.sent and W.acts' = W.acts and W.faults' = W.faults and W.net' = W.net }

-- One step of the system: what may happen next. The harness checks traces from init.
pred step {
  notify or nothing or (some e: Event | credit[e] or duplicate[e] or lose[e])
}

pred creditedOnce { W.balance <= W.sent }

-- Every integer the model keeps: the harness checks none comes near overflowing.
fun counts: set Int { W.sent + W.acts + W.balance + W.faults + univ.(W.net) }
