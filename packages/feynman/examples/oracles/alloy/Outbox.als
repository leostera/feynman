module Outbox
-- An independent model of examples/outbox.ts, for Alloy 6. A client places orders with a
-- shop, which records each and puts an announcement in its outbox; a guarded step publishes
-- what is in the outbox to a listener. A fault loses a message, or restarts the shop, which
-- keeps its orders and, fixed, its outbox (buggy: the outbox was in memory). The network is a
-- bag: a count of copies of each kind. The harness appends Buggy, Faults and Repeats.

one sig W {
  var orders, outbox, announced, acts, faults: one Int,
  -- PlaceOrder and OrderPlaced in flight.
  var placing, placed: one Int
}

pred init { W.orders = 0 and W.outbox = 0 and W.announced = 0 and W.acts = 0 and W.faults = 0 and W.placing = 0 and W.placed = 0 }

pred order {
  W.acts < Repeats and W.acts' = plus[W.acts, 1] and W.placing' = plus[W.placing, 1]
  W.orders' = W.orders and W.outbox' = W.outbox and W.announced' = W.announced and W.faults' = W.faults and W.placed' = W.placed
}

pred publish {
  W.outbox > 0 and W.outbox' = minus[W.outbox, 1] and W.placed' = plus[W.placed, 1]
  W.orders' = W.orders and W.announced' = W.announced and W.acts' = W.acts and W.faults' = W.faults and W.placing' = W.placing
}

pred placeOrder {
  W.placing > 0 and W.placing' = minus[W.placing, 1]
  W.orders' = plus[W.orders, 1] and W.outbox' = plus[W.outbox, 1]
  W.announced' = W.announced and W.acts' = W.acts and W.faults' = W.faults and W.placed' = W.placed
}

pred orderPlaced {
  W.placed > 0 and W.placed' = minus[W.placed, 1] and W.announced' = plus[W.announced, 1]
  W.orders' = W.orders and W.outbox' = W.outbox and W.acts' = W.acts and W.faults' = W.faults and W.placing' = W.placing
}

pred spend { W.faults < Faults and W.faults' = plus[W.faults, 1] }

pred placingLost {
  spend and W.placing > 0 and W.placing' = minus[W.placing, 1]
  W.orders' = W.orders and W.outbox' = W.outbox and W.announced' = W.announced and W.acts' = W.acts and W.placed' = W.placed
}

pred placedLost {
  spend and W.placed > 0 and W.placed' = minus[W.placed, 1]
  W.orders' = W.orders and W.outbox' = W.outbox and W.announced' = W.announced and W.acts' = W.acts and W.placing' = W.placing
}

pred restart {
  spend
  Buggy implies W.outbox' = 0 else W.outbox' = W.outbox
  W.orders' = W.orders and W.announced' = W.announced and W.acts' = W.acts and W.placing' = W.placing and W.placed' = W.placed
}

pred nothing {
  W.orders' = W.orders and W.outbox' = W.outbox and W.announced' = W.announced and W.acts' = W.acts
  W.faults' = W.faults and W.placing' = W.placing and W.placed' = W.placed
}

fact behaviour {
  init
  always (order or publish or placeOrder or orderPlaced or placingLost or placedLost or restart or nothing)
}

pred announcedOnceQuiet { (W.placing = 0 and W.placed = 0) implies (W.outbox > 0 or W.announced = W.orders) }
