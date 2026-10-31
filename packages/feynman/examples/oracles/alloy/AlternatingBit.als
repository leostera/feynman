module AlternatingBit
-- An independent model of examples/alternating-bit.ts, for Alloy 6. A sender sends two items,
-- x then y, resending the current one whenever its retry timer fires, and moves on when an
-- acknowledgement carries the current one's tag. The receiver keeps an item whose tag is the
-- one it expects next, and acknowledges every item with its tag. Buggy, the tag is one
-- alternating bit (position mod 2); fixed, it is the position. The network is a bag, so it
-- reorders. Both ends are singletons: the only faults are lost messages. What the receiver
-- kept is tracked by its length and whether it is a prefix of x, y so far: all the properties
-- read. The harness appends Buggy, Faults and Repeats.

-- An item's position: 0 is x, 1 is y.
abstract sig Pos { i: one Int }
one sig P0, P1 extends Pos {}
fact positions { P0.i = 0 and P1.i = 1 }

one sig W {
  -- The sender
  var next, acts: one Int,
  var started, retry: set W,
  -- The receiver: how many items it kept, and whether they are x, y so far.
  var kept: one Int,
  var inOrderSoFar: set W,
  -- Data in flight by the position it carries, acknowledgements by their tag.
  var data: Pos -> one Int,
  var ack: Int -> lone Int,
  var faults: one Int
}

fun tag[position: Int]: Int { Buggy implies rem[position, 2] else position }
-- Tags a message can carry: 0 and 1, either way.
fun Tags: set Int { 0 + 1 }

pred init {
  W.next = 0 and W.acts = 0 and no W.started and no W.retry and W.kept = 0 and W.inOrderSoFar = W and W.faults = 0
  all p: Pos | W.data[p] = 0
  W.ack = Tags -> 0
}

pred moveData[p: lone Pos, p2: lone Pos] {
  all x: Pos | W.data'[x] = plus[minus[W.data[x], x = p implies 1 else 0], x = p2 implies 1 else 0]
}
pred moveAck[t: lone Int, t2: lone Int] {
  W.ack' = { x: Tags, c: Int | c = plus[minus[W.ack[x], x = t implies 1 else 0], x = t2 implies 1 else 0] }
}

pred keepSender { W.next' = W.next and W.acts' = W.acts and W.started' = W.started and W.retry' = W.retry }
pred keepReceiver { W.kept' = W.kept and W.inOrderSoFar' = W.inOrderSoFar }

pred start {
  no W.started and W.acts < Repeats
  W.started' = W and W.acts' = plus[W.acts, 1] and W.retry' = W and W.next' = W.next
  moveData[none, P0] and moveAck[none, none]
  keepReceiver and W.faults' = W.faults
}

-- The receiver keeps the item if its tag is the one expected next, and acknowledges it.
pred onData[p: Pos] {
  W.data[p] > 0 and moveData[p, none] and moveAck[none, tag[p.i]]
  tag[p.i] = tag[W.kept] implies {
    W.kept' = plus[W.kept, 1]
    (some W.inOrderSoFar and p.i = W.kept) implies W.inOrderSoFar' = W else no W.inOrderSoFar'
  } else keepReceiver
  keepSender and W.faults' = W.faults
}

pred onAck[t: Int] {
  t in Tags and W.ack[t] > 0 and moveAck[t, none]
  (W.next >= 2 or t != tag[W.next]) implies { keepSender and moveData[none, none] }
  else {
    W.next' = plus[W.next, 1] and W.acts' = W.acts and W.started' = W.started
    W.next = 1 implies { no W.retry' and moveData[none, none] }
    else { W.retry' = W and moveData[none, P1] }
  }
  keepReceiver and W.faults' = W.faults
}

pred retry {
  some W.retry and moveAck[none, none]
  W.next >= 2 implies { no W.retry' and moveData[none, none] }
  else { W.retry' = W.retry and moveData[none, { p: Pos | p.i = W.next }] }
  W.next' = W.next and W.acts' = W.acts and W.started' = W.started
  keepReceiver and W.faults' = W.faults
}

pred spend { W.faults < Faults and W.faults' = plus[W.faults, 1] }

pred dataLost[p: Pos] { spend and W.data[p] > 0 and moveData[p, none] and moveAck[none, none] and keepSender and keepReceiver }
pred ackLost[t: Int] { spend and t in Tags and W.ack[t] > 0 and moveAck[t, none] and moveData[none, none] and keepSender and keepReceiver }

pred nothing { keepSender and keepReceiver and W.data' = W.data and W.ack' = W.ack and W.faults' = W.faults }

-- One step of the system: what may happen next. The harness checks traces from init.
pred step {
  start or retry or nothing or (some p: Pos | onData[p] or dataLost[p]) or (some t: Tags | onAck[t] or ackLost[t])
}

pred inStep { W.next <= W.kept }
pred inOrder { W.kept <= 2 and some W.inOrderSoFar }

-- Every integer the model keeps: the harness checks none comes near overflowing.
fun counts: set Int { W.next + W.acts + W.kept + univ.(W.data) + univ.(W.ack) + W.faults }
