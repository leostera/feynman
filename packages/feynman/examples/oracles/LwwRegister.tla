---------------------------- MODULE LwwRegister ----------------------------
(* An independent model of examples/lww-register.ts: two writers, two replicas.  *)
(* Writers are numbered in the order the spec's ids sort (writer A before B), so *)
(* ties break the same way; 0 stands for no writer. A writer's restart resets   *)
(* its clock; a replica's changes nothing, what it holds being durable.         *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Writers == {1, 2}
Replicas == {"ra", "rb"}

VARIABLES clock, held, net, acts, faults
vars == <<clock, held, net, acts, faults>>

Take(m) == net (-) SetToBag({m})
Newer(a, b) == a.ts > b.ts \/ (~Buggy /\ a.ts = b.ts /\ a.writer > b.writer)

Init ==
  /\ clock = [w \in Writers |-> 0]
  /\ held = [r \in Replicas |-> [ts |-> 0, writer |-> 0]]
  /\ net = EmptyBag /\ acts = [w \in Writers |-> 0] /\ faults = 0

Write(w) ==
  /\ acts[w] < Repeats /\ acts' = [acts EXCEPT ![w] = @ + 1]
  /\ clock' = [clock EXCEPT ![w] = @ + 1]
  /\ net' = net (+) [m \in {[ts |-> clock[w] + 1, writer |-> w, to |-> r] : r \in Replicas} |-> 1]
  /\ UNCHANGED <<held, faults>>

Deliver(m) ==
  /\ BagIn(m, net) /\ net' = Take(m)
  /\ held' = IF Newer(m, held[m.to]) THEN [held EXCEPT ![m.to] = [ts |-> m.ts, writer |-> m.writer]] ELSE held
  /\ UNCHANGED <<clock, acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<clock, held, acts>>

RestartWriter(w) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ clock' = [clock EXCEPT ![w] = 0]
  /\ UNCHANGED <<held, net, acts>>

\* A replica restarting changes nothing but the budget.
RestartReplica ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ UNCHANGED <<clock, held, net, acts>>

Next ==
  \/ \E w \in Writers : Write(w) \/ RestartWriter(w)
  \/ RestartReplica
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

convergesOnceQuiet == net # EmptyBag \/ held["ra"] = held["rb"]
=============================================================================
