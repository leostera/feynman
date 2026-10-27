----------------------------- MODULE ChangRoberts -----------------------------
(* An independent model of examples/chang-roberts.ts: nodes a < b < c in a ring, *)
(* a to b to c to a. A restart forgets whether a node started and whether it    *)
(* leads.                                                                       *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Nodes == {"a", "b", "c"}
Succ(n) == CASE n = "a" -> "b" [] n = "b" -> "c" [] n = "c" -> "a"
Greater(x, y) == (x = "c" /\ y # "c") \/ (x = "b" /\ y = "a")

VARIABLES started, leader, net, acts, faults
vars == <<started, leader, net, acts, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})
Election(n, id) == [from |-> n, to |-> Succ(n), id |-> id]

Init ==
  /\ started = [n \in Nodes |-> FALSE] /\ leader = [n \in Nodes |-> FALSE]
  /\ net = EmptyBag /\ acts = [n \in Nodes |-> 0] /\ faults = 0

Start(n) ==
  /\ ~started[n] /\ acts[n] < Repeats
  /\ acts' = [acts EXCEPT ![n] = @ + 1] /\ started' = [started EXCEPT ![n] = TRUE]
  /\ net' = net (+) Send(Election(n, n))
  /\ UNCHANGED <<leader, faults>>

Deliver(m) ==
  LET n == m.to IN
  /\ BagIn(m, net)
  /\ CASE Greater(m.id, n) ->
            net' = Take(m) (+) Send(Election(n, m.id)) /\ UNCHANGED <<started, leader>>
       [] m.id = n ->
            leader' = [leader EXCEPT ![n] = TRUE] /\ net' = Take(m) /\ UNCHANGED started
       [] OTHER ->
            /\ leader' = IF Buggy THEN [leader EXCEPT ![n] = TRUE] ELSE leader
            /\ IF started[n]
                 THEN net' = Take(m) /\ UNCHANGED started
                 ELSE started' = [started EXCEPT ![n] = TRUE] /\ net' = Take(m) (+) Send(Election(n, n))
  /\ UNCHANGED <<acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<started, leader, acts>>

Restart(n) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ started' = [started EXCEPT ![n] = FALSE] /\ leader' = [leader EXCEPT ![n] = FALSE]
  /\ UNCHANGED <<net, acts>>

Next ==
  \/ \E n \in Nodes : Start(n) \/ Restart(n)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

oneLeader == \A x, y \in Nodes : leader[x] /\ leader[y] => x = y
=============================================================================
