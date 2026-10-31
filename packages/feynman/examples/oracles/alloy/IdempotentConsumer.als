module IdempotentConsumer
-- An independent model of examples/idempotent-consumer.ts, for Alloy 6. A broker hands one job
-- to a consumer and hands it over again each time its timer fires, until the consumer says it
-- is done. The consumer charges for a job it does not remember doing. A fault loses a message,
-- or restarts the consumer, which keeps what it charged and, fixed, which jobs it has done
-- (buggy: that memory was not on disk). The broker does not restart. The network is a bag: a
-- count of copies of each kind. The harness appends Buggy, Faults and Repeats.

abstract sig Kind {}
one sig Job, Done extends Kind {}

one sig W {
  -- The broker
  var published: one Int,
  var unacked, timer: set W,
  -- The consumer
  var processed: set W,
  var charged: one Int,
  var net: Kind -> one Int,
  var faults: one Int
}

pred init { W.published = 0 and no W.unacked and no W.timer and no W.processed and W.charged = 0 and W.faults = 0 and (all k: Kind | W.net[k] = 0) }

pred moves[k: lone Kind, k2: lone Kind] {
  all x: Kind | W.net'[x] = plus[minus[W.net[x], x = k implies 1 else 0], x = k2 implies 1 else 0]
}

pred keepConsumer { W.processed' = W.processed and W.charged' = W.charged }

-- One job: publishing is possible once (and at most Repeats times).
pred publish {
  W.published < 1 and W.published < Repeats
  W.published' = plus[W.published, 1] and W.unacked' = W and W.timer' = W and moves[none, Job]
  keepConsumer and W.faults' = W.faults
}

pred redeliver {
  some W.timer
  no W.unacked implies { no W.timer' and moves[none, none] } else { W.timer' = W.timer and moves[none, Job] }
  W.published' = W.published and W.unacked' = W.unacked and keepConsumer and W.faults' = W.faults
}

pred onJob {
  W.net[Job] > 0 and moves[Job, Done]
  W.processed' = W
  some W.processed implies W.charged' = W.charged else W.charged' = plus[W.charged, 1]
  W.published' = W.published and W.unacked' = W.unacked and W.timer' = W.timer and W.faults' = W.faults
}

pred onDone {
  W.net[Done] > 0 and moves[Done, none]
  no W.unacked' and no W.timer'
  W.published' = W.published and keepConsumer and W.faults' = W.faults
}

pred spend { W.faults < Faults and W.faults' = plus[W.faults, 1] }

pred lose[k: Kind] {
  spend and W.net[k] > 0 and moves[k, none]
  W.published' = W.published and W.unacked' = W.unacked and W.timer' = W.timer and keepConsumer
}

pred restart {
  spend
  Buggy implies no W.processed' else W.processed' = W.processed
  W.charged' = W.charged and W.published' = W.published and W.unacked' = W.unacked and W.timer' = W.timer and W.net' = W.net
}

pred nothing { W.published' = W.published and W.unacked' = W.unacked and W.timer' = W.timer and keepConsumer and W.net' = W.net and W.faults' = W.faults }

-- One step of the system: what may happen next. The harness checks traces from init.
pred step {
  publish or redeliver or onJob or onDone or restart or nothing or (some k: Kind | lose[k])
}

pred chargedOnce { W.charged <= 1 }

-- Every integer the model keeps: the harness checks none comes near overflowing.
fun counts: set Int { W.published + W.charged + univ.(W.net) + W.faults }
