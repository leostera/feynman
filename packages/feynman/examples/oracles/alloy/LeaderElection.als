module LeaderElection
-- An independent model of examples/leader-election.ts, for Alloy 6. Three nodes, ordered by
-- their ids, each announce themselves to the others; a node takes a heard id as its leader
-- when it is higher (fixed) or always (buggy). The network is a bag: a count of copies per
-- (to, from). A fault loses an announcement, or restarts a node, which forgets everything (no
-- field is durable) but not how often it has announced. The harness appends Buggy, Faults and
-- Repeats.

abstract sig Node { id: one Int }
one sig N1, N2, N3 extends Node {}
fact ids { N1.id = 1 and N2.id = 2 and N3.id = 3 }

one sig W {
  var leader: Node -> one Node,
  var announced: set Node,
  var acts: Node -> one Int,
  -- Announcements in flight, by receiver and sender (the id they carry is the sender's).
  var net: Node -> Node -> one Int,
  var faults: one Int
}

pred init {
  all n: Node | W.leader[n] = n and W.acts[n] = 0 and (all m: Node | W.net[n][m] = 0)
  no W.announced and W.faults = 0
}

pred announce[n: Node] {
  n not in W.announced and W.acts[n] < Repeats
  W.announced' = W.announced + n
  W.acts' = W.acts ++ n -> plus[W.acts[n], 1]
  all to, from: Node | W.net'[to][from] = ((from = n and to != n) implies plus[W.net[to][from], 1] else W.net[to][from])
  W.leader' = W.leader and W.faults' = W.faults
}

pred deliver[to, from: Node] {
  W.net[to][from] > 0
  W.net' = W.net - to -> from -> Int + to -> from -> minus[W.net[to][from], 1]
  (Buggy or from.id > W.leader[to].id) implies W.leader' = W.leader ++ to -> from else W.leader' = W.leader
  W.announced' = W.announced and W.acts' = W.acts and W.faults' = W.faults
}

pred lose[to, from: Node] {
  W.faults < Faults and W.faults' = plus[W.faults, 1]
  W.net[to][from] > 0
  W.net' = W.net - to -> from -> Int + to -> from -> minus[W.net[to][from], 1]
  W.leader' = W.leader and W.announced' = W.announced and W.acts' = W.acts
}

pred restart[n: Node] {
  W.faults < Faults and W.faults' = plus[W.faults, 1]
  W.leader' = W.leader ++ n -> n and W.announced' = W.announced - n
  W.acts' = W.acts and W.net' = W.net
}

pred nothing { W.leader' = W.leader and W.announced' = W.announced and W.acts' = W.acts and W.net' = W.net and W.faults' = W.faults }

fact behaviour {
  init
  always (nothing or (some n: Node | announce[n] or restart[n]) or (some to, from: Node | deliver[to, from] or lose[to, from]))
}

pred quiet { all to, from: Node | W.net[to][from] = 0 }
pred agreeOnceQuiet { (quiet and W.announced = Node) implies (all a, b: Node | W.leader[a] = W.leader[b]) }
