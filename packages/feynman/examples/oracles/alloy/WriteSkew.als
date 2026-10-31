module WriteSkew
-- An independent model of examples/write-skew.ts, for Alloy 6, with two doctors and a roster.
-- Buggy, a doctor asks the roster how many are on call and, when it is two, leaves in a
-- second message, so both can see two and both leave. Fixed, the roster checks and removes
-- in one step. The network is a bag: a count of copies per doctor and kind of message. A
-- count the roster sends is only ever compared with 2, so it travels as Low or High. A fault
-- loses a message, or restarts a doctor, who goes back to "on" in their own mind. The harness
-- appends Buggy, Faults and Repeats.

abstract sig Doctor {}
one sig DA, DB extends Doctor {}
abstract sig Phase {}
one sig On, Asking, Off extends Phase {}
-- To the roster: Check, Leave, LeaveIfCovered. To a doctor: Count (Low: under 2, High), Left, Stay.
abstract sig Kind {}
one sig Check, Leave, LeaveIfCovered, CountLow, CountHigh, Left, Stay extends Kind {}

one sig W {
  var onCall: one Int,
  var phase: Doctor -> one Phase,
  var acts: Doctor -> one Int,
  var net: Doctor -> Kind -> one Int,
  var faults: one Int
}

pred init {
  W.onCall = 2 and W.faults = 0
  all d: Doctor | W.phase[d] = On and W.acts[d] = 0 and (all k: Kind | W.net[d][k] = 0)
}

-- The network after taking one (d, k) and sending one (d2, k2) (none: nothing sent).
pred moves[d: Doctor, k: Kind, d2: lone Doctor, k2: lone Kind] {
  all x: Doctor, y: Kind | W.net'[x][y] = plus[minus[W.net[x][y], (x = d and y = k) implies 1 else 0], (x = d2 and y = k2) implies 1 else 0]
}

pred goOff[d: Doctor] {
  W.phase[d] = On and W.acts[d] < Repeats
  W.phase' = W.phase ++ d -> Asking and W.acts' = W.acts ++ d -> plus[W.acts[d], 1]
  all x: Doctor, y: Kind | W.net'[x][y] = plus[W.net[x][y], (x = d and y = (Buggy implies Check else LeaveIfCovered)) implies 1 else 0]
  W.onCall' = W.onCall and W.faults' = W.faults
}

pred onRoster[d: Doctor, k: Kind] {
  k in Check + Leave + LeaveIfCovered and W.net[d][k] > 0
  W.phase' = W.phase
  k = Check implies { W.onCall' = W.onCall and moves[d, k, d, (W.onCall < 2 implies CountLow else CountHigh)] }
  k = Leave implies { W.onCall' = minus[W.onCall, 1] and moves[d, k, none, none] }
  k = LeaveIfCovered implies {
    W.onCall < 2 implies { W.onCall' = W.onCall and moves[d, k, d, Stay] }
    else { W.onCall' = minus[W.onCall, 1] and moves[d, k, d, Left] }
  }
}

pred onDoctor[d: Doctor, k: Kind] {
  k in CountLow + CountHigh + Left + Stay and W.net[d][k] > 0
  W.onCall' = W.onCall
  k = CountLow implies { W.phase' = W.phase ++ d -> On and moves[d, k, none, none] }
  k = CountHigh implies { W.phase' = W.phase ++ d -> Off and moves[d, k, d, Leave] }
  k = Left implies { W.phase' = W.phase ++ d -> Off and moves[d, k, none, none] }
  k = Stay implies { W.phase' = W.phase ++ d -> On and moves[d, k, none, none] }
}

pred deliver[d: Doctor, k: Kind] { (onRoster[d, k] or onDoctor[d, k]) and W.acts' = W.acts and W.faults' = W.faults }

pred lose[d: Doctor, k: Kind] {
  W.faults < Faults and W.faults' = plus[W.faults, 1] and W.net[d][k] > 0
  moves[d, k, none, none]
  W.onCall' = W.onCall and W.phase' = W.phase and W.acts' = W.acts
}

pred restart[d: Doctor] {
  W.faults < Faults and W.faults' = plus[W.faults, 1]
  W.phase' = W.phase ++ d -> On
  W.onCall' = W.onCall and W.acts' = W.acts and W.net' = W.net
}

pred nothing { W.onCall' = W.onCall and W.phase' = W.phase and W.acts' = W.acts and W.net' = W.net and W.faults' = W.faults }

-- One step of the system: what may happen next. The harness checks traces from init.
pred step {
  nothing or (some d: Doctor | goOff[d] or restart[d]) or (some d: Doctor, k: Kind | deliver[d, k] or lose[d, k])
}

pred covered { W.onCall >= 1 }

-- Every integer the model keeps: the harness checks none comes near overflowing.
fun counts: set Int { W.onCall + univ.(W.acts) + univ.(univ.(W.net)) + W.faults }
