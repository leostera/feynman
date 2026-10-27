----------------------------- MODULE GCounter -----------------------------
(* An independent model of examples/g-counter.ts: two replicas. Buggy, each      *)
(* keeps a total and merges by the larger; fixed, a count per replica, merged    *)
(* pointwise. Everything is durable, so a restart changes nothing but the        *)
(* budget. A replica's own increments are `acts`, which also bounds them.        *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Replicas == {"a", "b"}
Other(r) == CHOOSE o \in Replicas : o # r
Max(x, y) == IF x > y THEN x ELSE y

VARIABLES total, counts, net, acts, faults
vars == <<total, counts, net, acts, faults>>

Take(m) == net (-) SetToBag({m})
Value(r) == IF Buggy THEN total[r] ELSE counts[r]["a"] + counts[r]["b"]

Init ==
  /\ total = [r \in Replicas |-> 0]
  /\ counts = [r \in Replicas |-> [o \in Replicas |-> 0]]
  /\ net = EmptyBag /\ acts = [r \in Replicas |-> 0] /\ faults = 0

Increment(r) ==
  /\ acts[r] < Repeats /\ acts' = [acts EXCEPT ![r] = @ + 1]
  /\ IF Buggy
       THEN /\ total' = [total EXCEPT ![r] = @ + 1] /\ UNCHANGED counts
            /\ net' = net (+) SetToBag({[to |-> Other(r), total |-> total[r] + 1, counts |-> <<>>]})
       ELSE /\ counts' = [counts EXCEPT ![r][r] = @ + 1] /\ UNCHANGED total
            /\ net' = net (+) SetToBag({[to |-> Other(r), total |-> 0, counts |-> [counts[r] EXCEPT ![r] = @ + 1]]})
  /\ UNCHANGED faults

Deliver(m) ==
  /\ BagIn(m, net) /\ net' = Take(m)
  /\ IF Buggy
       THEN total' = [total EXCEPT ![m.to] = Max(@, m.total)] /\ UNCHANGED counts
       ELSE counts' = [counts EXCEPT ![m.to] = [o \in Replicas |-> Max(@[o], m.counts[o])]] /\ UNCHANGED total
  /\ UNCHANGED <<acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<total, counts, acts>>

\* A replica restarting changes nothing but the budget: all of its state is durable.
Restart ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ UNCHANGED <<total, counts, net, acts>>

Next == \/ \E r \in Replicas : Increment(r)
        \/ Restart
        \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

countsEveryIncrementOnceQuiet == net # EmptyBag \/ \A r \in Replicas : Value(r) = acts["a"] + acts["b"]
=============================================================================
