------------------------------- MODULE Barrier -------------------------------
(* An independent model of examples/barrier.ts, with workers a and b. Buggy, the  *)
(* coordinator counts arrivals; fixed, it lists who arrived. A restart makes a    *)
(* worker forget it arrived, but not that it reached the barrier.                 *)
EXTENDS Naturals, Bags, Sequences

CONSTANTS Buggy, Faults, Repeats

Workers == {"a", "b"}
Has(s, x) == \E i \in 1..Len(s) : s[i] = x

VARIABLES count, arrivedAt, open, arrived, reached, through, net, acts, faults
vars == <<count, arrivedAt, open, arrived, reached, through, net, acts, faults>>

Take(m) == net (-) SetToBag({m})

Init ==
  /\ count = 0 /\ arrivedAt = <<>> /\ open = FALSE
  /\ arrived = [w \in Workers |-> FALSE] /\ reached = [w \in Workers |-> FALSE] /\ through = [w \in Workers |-> FALSE]
  /\ net = EmptyBag /\ acts = [w \in Workers |-> 0] /\ faults = 0

Arrive(w) ==
  /\ ~arrived[w] /\ acts[w] < Repeats
  /\ acts' = [acts EXCEPT ![w] = @ + 1]
  /\ arrived' = [arrived EXCEPT ![w] = TRUE] /\ reached' = [reached EXCEPT ![w] = TRUE]
  /\ net' = net (+) SetToBag({[type |-> "Arrived", from |-> w]})
  /\ UNCHANGED <<count, arrivedAt, open, through, faults>>

OnArrived(m) ==
  IF open
    THEN net' = Take(m) /\ UNCHANGED <<count, arrivedAt, open>>
    ELSE LET c == IF Buggy THEN count + 1 ELSE count
             l == IF ~Buggy /\ ~Has(arrivedAt, m.from) THEN Append(arrivedAt, m.from) ELSE arrivedAt
             here == IF Buggy THEN c ELSE Len(l)
         IN /\ count' = c /\ arrivedAt' = l
            /\ IF here >= 2
                 THEN open' = TRUE /\ net' = Take(m) (+) SetToBag({[type |-> "Go", to |-> w] : w \in Workers})
                 ELSE net' = Take(m) /\ UNCHANGED open

OnGo(m) == through' = [through EXCEPT ![m.to] = TRUE] /\ net' = Take(m)

Deliver(m) ==
  /\ BagIn(m, net)
  /\ IF m.type = "Arrived"
       THEN OnArrived(m) /\ UNCHANGED through
       ELSE OnGo(m) /\ UNCHANGED <<count, arrivedAt, open>>
  /\ UNCHANGED <<arrived, reached, acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<count, arrivedAt, open, arrived, reached, through, acts>>

Restart(w) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ arrived' = [arrived EXCEPT ![w] = FALSE] /\ through' = [through EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<count, arrivedAt, open, reached, net, acts>>

Next ==
  \/ \E w \in Workers : Arrive(w) \/ Restart(w)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

waitsForAll == open => \A w \in Workers : reached[w]
=============================================================================
