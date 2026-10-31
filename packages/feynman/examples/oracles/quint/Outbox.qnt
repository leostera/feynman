// An independent model of examples/outbox.ts, in Quint, for Apalache. A client places orders;
// the shop stores each and queues its announcement in an outbox, which a guarded step
// publishes to a mailer. A fault loses a message, or restarts the shop, which keeps its orders
// and, fixed, its outbox. The network is a bag: a count of copies per kind. The harness sets
// BUGGY, FAULTS and REPEATS.
module Outbox {
  const BUGGY: bool
  const FAULTS: int
  const REPEATS: int

  type Message = PlaceOrder | OrderPlaced

  var orders: int
  var outbox: int
  var announced: int
  var acts: int
  var net: Message -> int
  var faults: int

  action init = all { orders' = 0, outbox' = 0, announced' = 0, acts' = 0, net' = Set(PlaceOrder, OrderPlaced).mapBy(_ => 0), faults' = 0 }

  action order = all {
    acts < REPEATS, acts' = acts + 1, net' = net.setBy(PlaceOrder, n => n + 1),
    orders' = orders, outbox' = outbox, announced' = announced, faults' = faults,
  }
  action publish = all {
    outbox > 0, outbox' = outbox - 1, net' = net.setBy(OrderPlaced, n => n + 1),
    orders' = orders, announced' = announced, acts' = acts, faults' = faults,
  }
  action placeOrder = all {
    net.get(PlaceOrder) > 0, net' = net.setBy(PlaceOrder, n => n - 1), orders' = orders + 1, outbox' = outbox + 1,
    announced' = announced, acts' = acts, faults' = faults,
  }
  action orderPlaced = all {
    net.get(OrderPlaced) > 0, net' = net.setBy(OrderPlaced, n => n - 1), announced' = announced + 1,
    orders' = orders, outbox' = outbox, acts' = acts, faults' = faults,
  }
  action lose(m: Message): bool = all {
    faults < FAULTS, net.get(m) > 0, net' = net.setBy(m, n => n - 1), faults' = faults + 1,
    orders' = orders, outbox' = outbox, announced' = announced, acts' = acts,
  }
  action restart = all {
    faults < FAULTS, faults' = faults + 1, outbox' = if (BUGGY) 0 else outbox,
    orders' = orders, announced' = announced, acts' = acts, net' = net,
  }
  action nothing = all { orders' = orders, outbox' = outbox, announced' = announced, acts' = acts, net' = net, faults' = faults }

  action step = any { order, publish, placeOrder, orderPlaced, lose(PlaceOrder), lose(OrderPlaced), restart, nothing }

  val announcedOnceQuiet = net.get(PlaceOrder) + net.get(OrderPlaced) > 0 or outbox > 0 or announced == orders
}
