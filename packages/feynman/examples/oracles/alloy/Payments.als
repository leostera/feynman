module Payments
-- An independent model of examples/payments.ts, for Alloy 6, with one client. The client pays
-- under a fresh id, keeps the payment pending, and resends it whenever its retry timer fires
-- (the timer may fire at any time while it is set: the network may be slower than it). The
-- bank debits every Debit (buggy) or each id once (fixed), and answers. A fault loses a
-- message, or restarts the client, which keeps what it paid and what is pending but loses its
-- timer. The network is a bag: a count of copies per kind and id. The harness appends Buggy,
-- Faults and Repeats.

abstract sig Id { n: one Int }
one sig I1, I2 extends Id {}
fact ids { I1.n = 1 and I2.n = 2 }
abstract sig Kind {}
one sig Debit, Debited extends Kind {}

one sig W {
  -- The bank
  var debits: one Int,
  var seen: set Id,
  -- The client
  var paid, acts, fresh: one Int,
  var pending: lone Id,
  var timer: set W,
  var net: Kind -> Id -> one Int,
  var faults: one Int
}

pred init {
  W.debits = 0 and no W.seen and W.paid = 0 and W.acts = 0 and W.fresh = 0
  no W.pending and no W.timer and W.faults = 0
  all k: Kind, i: Id | W.net[k][i] = 0
}

-- The network after taking one (k, i) (none: nothing) and sending one (k2, i2) (none: nothing).
pred moves[k: lone Kind, i: lone Id, k2: lone Kind, i2: lone Id] {
  all x: Kind, y: Id | W.net'[x][y] = plus[minus[W.net[x][y], (x = k and y = i) implies 1 else 0], (x = k2 and y = i2) implies 1 else 0]
}

pred keepBank { W.debits' = W.debits and W.seen' = W.seen }
pred keepClient { W.paid' = W.paid and W.acts' = W.acts and W.fresh' = W.fresh and W.pending' = W.pending and W.timer' = W.timer }

pred pay {
  no W.pending and W.acts < Repeats
  let id = { i: Id | i.n = plus[W.fresh, 1] } {
    one id and W.pending' = id and moves[none, none, Debit, id]
  }
  W.fresh' = plus[W.fresh, 1] and W.paid' = plus[W.paid, 1] and W.acts' = plus[W.acts, 1] and W.timer' = W
  keepBank and W.faults' = W.faults
}

pred onDebit[i: Id] {
  W.net[Debit][i] > 0 and moves[Debit, i, Debited, i]
  (not Buggy and i in W.seen) implies keepBank else { W.debits' = plus[W.debits, 1] and W.seen' = W.seen + i }
  keepClient and W.faults' = W.faults
}

pred onDebited[i: Id] {
  W.net[Debited][i] > 0 and moves[Debited, i, none, none]
  W.pending = i implies { no W.pending' and no W.timer' } else { W.pending' = W.pending and W.timer' = W.timer }
  W.paid' = W.paid and W.acts' = W.acts and W.fresh' = W.fresh
  keepBank and W.faults' = W.faults
}

pred retry {
  some W.timer
  no W.pending implies { no W.timer' and moves[none, none, none, none] } else { W.timer' = W.timer and moves[none, none, Debit, W.pending] }
  W.paid' = W.paid and W.acts' = W.acts and W.fresh' = W.fresh and W.pending' = W.pending
  keepBank and W.faults' = W.faults
}

pred spend { W.faults < Faults and W.faults' = plus[W.faults, 1] }

pred lose[k: Kind, i: Id] { spend and W.net[k][i] > 0 and moves[k, i, none, none] and keepBank and keepClient }

pred restart {
  spend and no W.timer'
  W.paid' = W.paid and W.acts' = W.acts and W.fresh' = W.fresh and W.pending' = W.pending
  keepBank and W.net' = W.net
}

pred nothing { keepBank and keepClient and W.net' = W.net and W.faults' = W.faults }

fact behaviour {
  init
  always (pay or retry or restart or nothing or (some i: Id | onDebit[i] or onDebited[i]) or (some k: Kind, i: Id | lose[k, i]))
}

pred debitedOnce { W.debits <= W.paid }
