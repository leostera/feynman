module PrimaryBackup
-- An independent model of examples/primary-backup.ts, for Alloy 6. A client writes to a
-- primary, which stores the write and replicates it to a backup; the client is acknowledged
-- as the primary stores (buggy) or once the backup confirms (fixed). A fault loses a message,
-- or restarts a server, which keeps what it stored: a restart only spends the budget. The
-- network is a bag: a count of copies of each kind. The harness appends Buggy, Faults and
-- Repeats.

abstract sig Kind {}
one sig Write, Replicate, Replicated, Ack extends Kind {}

one sig W {
  var acked, primary, backup, acts, faults: one Int,
  var net: Kind -> one Int
}

pred init { W.acked = 0 and W.primary = 0 and W.backup = 0 and W.acts = 0 and W.faults = 0 and (all k: Kind | W.net[k] = 0) }

-- The network after taking one k (none: nothing) and sending the kinds in `sent`, one copy each.
pred moves[k: lone Kind, sent: set Kind] {
  all x: Kind | W.net'[x] = plus[minus[W.net[x], x = k implies 1 else 0], x in sent implies 1 else 0]
}

pred keepStores { W.acked' = W.acked and W.primary' = W.primary and W.backup' = W.backup }

pred write {
  W.acts < Repeats and W.acts' = plus[W.acts, 1] and moves[none, Write]
  keepStores and W.faults' = W.faults
}

pred deliver[k: Kind] {
  W.net[k] > 0 and W.acts' = W.acts and W.faults' = W.faults
  k = Write implies {
    W.primary' = plus[W.primary, 1] and W.acked' = W.acked and W.backup' = W.backup
    Buggy implies moves[k, Ack + Replicate] else moves[k, Replicate]
  }
  k = Replicate implies {
    W.backup' = plus[W.backup, 1] and W.acked' = W.acked and W.primary' = W.primary
    Buggy implies moves[k, none] else moves[k, Replicated]
  }
  k = Replicated implies { keepStores and moves[k, Ack] }
  k = Ack implies { W.acked' = plus[W.acked, 1] and W.primary' = W.primary and W.backup' = W.backup and moves[k, none] }
}

pred lose[k: Kind] {
  W.faults < Faults and W.faults' = plus[W.faults, 1] and W.net[k] > 0
  moves[k, none] and keepStores and W.acts' = W.acts
}

pred restart {
  W.faults < Faults and W.faults' = plus[W.faults, 1]
  keepStores and W.acts' = W.acts and W.net' = W.net
}

pred nothing { keepStores and W.acts' = W.acts and W.faults' = W.faults and W.net' = W.net }

-- One step of the system: what may happen next. The harness checks traces from init.
pred step {
  write or restart or nothing or (some k: Kind | deliver[k] or lose[k])
}

pred ackedIsReplicated { W.acked <= W.backup }

-- Every integer the model keeps: the harness checks none comes near overflowing.
fun counts: set Int { W.acked + W.primary + W.backup + W.acts + W.faults + univ.(W.net) }
