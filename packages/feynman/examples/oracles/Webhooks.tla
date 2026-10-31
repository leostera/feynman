------------------------------- MODULE Webhooks -------------------------------
(* An independent model of examples/webhooks.ts, for TLC to check. A provider    *)
(* sends two events, in order; the shop credits each, skipping the last event    *)
(* seen (buggy) or any event seen before (fixed). The network is a bag, and a    *)
(* fault duplicates an event in flight (one more copy) or loses one. Both are    *)
(* singletons and neither restarts. Notifying happens at most Repeats times.     *)
(* What the fixed shop has seen is a list in the order it credited them, as in   *)
(* the spec: two orders of arrival are two states.                               *)
EXTENDS Naturals, Bags, Sequences

CONSTANTS Buggy, Faults, Repeats

Events == <<"evt-1", "evt-2">>
Amount == 10

VARIABLES sent, acts, balance, last, seen, net, faults
vars == <<sent, acts, balance, last, seen, net, faults>>

One(e) == SetToBag({e})

Init ==
  /\ sent = 0 /\ acts = 0 /\ balance = 0 /\ last = "none" /\ seen = <<>>
  /\ net = EmptyBag /\ faults = 0

Notify ==
  /\ sent < 2 /\ acts < Repeats
  /\ net' = net (+) One(Events[sent + 1])
  /\ sent' = sent + 1 /\ acts' = acts + 1
  /\ UNCHANGED <<balance, last, seen, faults>>

Credit(e) ==
  /\ BagIn(e, net) /\ net' = net (-) One(e)
  /\ IF Buggy
       THEN IF last = e THEN UNCHANGED <<balance, last>> ELSE balance' = balance + Amount /\ last' = e
       ELSE UNCHANGED last
  /\ IF Buggy
       THEN UNCHANGED seen
       ELSE IF \E i \in 1..Len(seen) : seen[i] = e THEN UNCHANGED <<balance, seen>> ELSE balance' = balance + Amount /\ seen' = Append(seen, e)
  /\ UNCHANGED <<sent, acts, faults>>

Duplicate(e) ==
  /\ faults < Faults /\ BagIn(e, net)
  /\ net' = net (+) One(e) /\ faults' = faults + 1
  /\ UNCHANGED <<sent, acts, balance, last, seen>>

Lose(e) ==
  /\ faults < Faults /\ BagIn(e, net)
  /\ net' = net (-) One(e) /\ faults' = faults + 1
  /\ UNCHANGED <<sent, acts, balance, last, seen>>

Next == Notify \/ \E e \in DOMAIN net : Credit(e) \/ Duplicate(e) \/ Lose(e)

creditedOnce == balance <= Amount * sent
=============================================================================
