---------------------------- MODULE RetriedCall ----------------------------
(* An independent model of examples/retried-call.ts, for TLC to check. A client *)
(* pays through a call to the bank and, when the call fails, sends the same      *)
(* charge again. The bank charges every charge (buggy), or once per payment      *)
(* (fixed). It follows Feynman's semantics for calls (RFD0009): the network is a *)
(* bag; a fault loses a charge, or the answer to one, and either way the client  *)
(* is told its call failed; that failure happens in the client, so it is never   *)
(* lost. Neither side restarts. The client pays at most Repeats times.            *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Payment == "pay-1"
Charge == [type |-> "Charge", payment |-> Payment]
Charged == [type |-> "Charged", payment |-> Payment]
Failed == [type |-> "Failed", payment |-> Payment]

VARIABLES paying, paid, charges, seen, net, pays, faults

One(m) == SetToBag({m})
Take(m) == net (-) One(m)

Init ==
  /\ paying = FALSE /\ paid = FALSE /\ charges = 0 /\ seen = {}
  /\ net = EmptyBag /\ pays = 0 /\ faults = 0

Pay ==
  /\ ~paying /\ ~paid /\ pays < Repeats
  /\ paying' = TRUE /\ pays' = pays + 1
  /\ net' = net (+) One(Charge)
  /\ UNCHANGED <<paid, charges, seen, faults>>

\* The bank charges, unless (fixed) it has charged this payment, and answers.
BankCharges ==
  /\ BagIn(Charge, net)
  /\ charges' = IF Buggy \/ Payment \notin seen THEN charges + 1 ELSE charges
  /\ seen' = IF Buggy THEN seen ELSE seen \cup {Payment}
  /\ net' = Take(Charge) (+) One(Charged)
  /\ UNCHANGED <<paying, paid, pays, faults>>

ClientPaid ==
  /\ BagIn(Charged, net)
  /\ paying' = FALSE /\ paid' = TRUE
  /\ net' = Take(Charged)
  /\ UNCHANGED <<charges, seen, pays, faults>>

\* The call threw: the client sends the same charge again.
ClientRetries ==
  /\ BagIn(Failed, net)
  /\ net' = Take(Failed) (+) One(Charge)
  /\ UNCHANGED <<paying, paid, charges, seen, pays, faults>>

\* Losing the charge or its answer fails the call: the client hears of it.
Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net) /\ m \in {Charge, Charged}
  /\ net' = Take(m) (+) One(Failed) /\ faults' = faults + 1
  /\ UNCHANGED <<paying, paid, charges, seen, pays>>

Next ==
  \/ Pay \/ BankCharges \/ ClientPaid \/ ClientRetries
  \/ \E m \in DOMAIN net : Lose(m)

chargedOnce == charges <= 1
=============================================================================
