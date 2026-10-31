--------------------------- MODULE LeaderElection ---------------------------
(* An independent model of specs/leader-election.ts. Nodes are 1..3, ordered as  *)
(* their ids are; a restart forgets everything (nothing is durable).              *)
EXTENDS Naturals, Bags, FiniteSets

CONSTANTS Buggy, Faults, Repeats

N == 1..3

VARIABLES leader, announced, net, acts, faults
vars == <<leader, announced, net, acts, faults>>

Init ==
  /\ leader = [n \in N |-> n]
  /\ announced = [n \in N |-> FALSE]
  /\ net = EmptyBag
  /\ acts = [n \in N |-> 0]
  /\ faults = 0

Announce(n) ==
  /\ ~announced[n] /\ acts[n] < Repeats
  /\ announced' = [announced EXCEPT ![n] = TRUE]
  /\ acts' = [acts EXCEPT ![n] = @ + 1]
  /\ net' = net (+) SetToBag({[to |-> m, from |-> n, id |-> n] : m \in N \ {n}})
  /\ UNCHANGED <<leader, faults>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ leader' = IF Buggy \/ m.id > leader[m.to] THEN [leader EXCEPT ![m.to] = m.id] ELSE leader
  /\ net' = net (-) SetToBag({m})
  /\ UNCHANGED <<announced, acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = net (-) SetToBag({m})
  /\ faults' = faults + 1
  /\ UNCHANGED <<leader, announced, acts>>

Restart(n) ==
  /\ faults < Faults
  /\ leader' = [leader EXCEPT ![n] = n]
  /\ announced' = [announced EXCEPT ![n] = FALSE]
  /\ faults' = faults + 1
  /\ UNCHANGED <<net, acts>>

Next == \/ \E n \in N : Announce(n) \/ Restart(n)
        \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

(* Feynman's fairness: a message in flight is delivered; announcing, losing and *)
(* restarting are not fair.                                                     *)
FairSpec ==
  /\ Init /\ [][Next]_vars
  /\ \A to, from \in N : WF_vars(Deliver([to |-> to, from |-> from, id |-> from]))

agree == (\A n \in N : announced[n]) ~> \A a, b \in N : leader[a] = leader[b]
agreeOnceQuiet == (net = EmptyBag /\ \A n \in N : announced[n]) => \A a, b \in N : leader[a] = leader[b]
=============================================================================
