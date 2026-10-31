module RetriedCall
-- An independent model of examples/retried-call.ts, for Alloy 6 to check by bounded search
-- over traces (SAT), not by enumerating states. A client pays through a call to the bank and,
-- when the call fails, sends the same charge again. The bank charges every charge (buggy), or
-- once per payment (fixed). The network is a bag, so what is in flight is a count of copies;
-- a fault loses a charge, or its answer, and either way the client is told its call failed.
-- That failure happens in the client, so it is never lost. The client pays at most Repeats
-- times. The harness appends Buggy, Faults and Repeats.

abstract sig Flag {}
one sig Paying, Paid, Seen extends Flag {}

one sig W {
  var on: set Flag,
  var charges, pays, faults: one Int,
  -- Copies in flight of the charge, its answer, and the failure of the call.
  var charge, charged, failed: one Int
}

pred init {
  no W.on
  W.charges = 0 and W.pays = 0 and W.faults = 0
  W.charge = 0 and W.charged = 0 and W.failed = 0
}

pred pay {
  Paying not in W.on and Paid not in W.on and W.pays < Repeats
  W.on' = W.on + Paying and W.pays' = plus[W.pays, 1]
  W.charge' = plus[W.charge, 1]
  W.charges' = W.charges and W.faults' = W.faults and W.charged' = W.charged and W.failed' = W.failed
}

-- The bank charges, unless (fixed) it has charged this payment, and answers.
pred bankCharges {
  W.charge > 0
  (Buggy or Seen not in W.on) implies W.charges' = plus[W.charges, 1] else W.charges' = W.charges
  Buggy implies W.on' = W.on else W.on' = W.on + Seen
  W.charge' = minus[W.charge, 1] and W.charged' = plus[W.charged, 1]
  W.pays' = W.pays and W.faults' = W.faults and W.failed' = W.failed
}

pred clientPaid {
  W.charged > 0
  W.on' = W.on - Paying + Paid
  W.charged' = minus[W.charged, 1]
  W.charges' = W.charges and W.pays' = W.pays and W.faults' = W.faults and W.charge' = W.charge and W.failed' = W.failed
}

-- The call threw: the client sends the same charge again.
pred clientRetries {
  W.failed > 0
  W.failed' = minus[W.failed, 1] and W.charge' = plus[W.charge, 1]
  W.on' = W.on and W.charges' = W.charges and W.pays' = W.pays and W.faults' = W.faults and W.charged' = W.charged
}

-- Losing the charge fails the call.
pred chargeLost {
  W.faults < Faults and W.charge > 0
  W.charge' = minus[W.charge, 1] and W.failed' = plus[W.failed, 1] and W.faults' = plus[W.faults, 1]
  W.on' = W.on and W.charges' = W.charges and W.pays' = W.pays and W.charged' = W.charged
}

-- Losing the answer fails the call too: the bank did the work, and the client cannot tell.
pred chargedLost {
  W.faults < Faults and W.charged > 0
  W.charged' = minus[W.charged, 1] and W.failed' = plus[W.failed, 1] and W.faults' = plus[W.faults, 1]
  W.on' = W.on and W.charges' = W.charges and W.pays' = W.pays and W.charge' = W.charge
}

pred nothing {
  W.on' = W.on and W.charges' = W.charges and W.pays' = W.pays and W.faults' = W.faults
  W.charge' = W.charge and W.charged' = W.charged and W.failed' = W.failed
}

fact behaviour {
  init
  always (pay or bankCharges or clientPaid or clientRetries or chargeLost or chargedLost or nothing)
}

pred chargedOnce { W.charges <= 1 }
