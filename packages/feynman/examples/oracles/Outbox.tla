------------------------------- MODULE Outbox -------------------------------
(* An independent model of examples/outbox.ts. The shop is the only actor that   *)
(* can restart; it keeps its orders, and, fixed, its outbox. Announcing is a     *)
(* guarded step, taken whenever the outbox has something in it.                  *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

VARIABLES orders, outbox, announced, net, acts, faults
vars == <<orders, outbox, announced, net, acts, faults>>

Take(m) == net (-) SetToBag({m})
Quiet == net = EmptyBag

Init == orders = 0 /\ outbox = 0 /\ announced = 0 /\ net = EmptyBag /\ acts = 0 /\ faults = 0

Order ==
  /\ acts < Repeats /\ acts' = acts + 1
  /\ net' = net (+) SetToBag({[type |-> "PlaceOrder"]})
  /\ UNCHANGED <<orders, outbox, announced, faults>>

Publish ==
  /\ outbox > 0 /\ outbox' = outbox - 1
  /\ net' = net (+) SetToBag({[type |-> "OrderPlaced"]})
  /\ UNCHANGED <<orders, announced, acts, faults>>

Deliver(m) ==
  /\ BagIn(m, net) /\ net' = Take(m)
  /\ IF m.type = "PlaceOrder"
       THEN orders' = orders + 1 /\ outbox' = outbox + 1 /\ UNCHANGED announced
       ELSE announced' = announced + 1 /\ UNCHANGED <<orders, outbox>>
  /\ UNCHANGED <<acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<orders, outbox, announced, acts>>

Restart ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ outbox' = IF Buggy THEN 0 ELSE outbox
  /\ UNCHANGED <<orders, announced, net, acts>>

Next == Order \/ Publish \/ Restart \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

announcedOnceQuiet == ~Quiet \/ outbox > 0 \/ announced = orders
=============================================================================
