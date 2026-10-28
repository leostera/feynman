---------------------------- MODULE PrimaryBackup ----------------------------
(* An independent model of examples/primary-backup.ts. The servers may restart,  *)
(* but keep what they have stored, so a restart only spends the fault budget.    *)
(* The client, the only one of its kind, does not restart. Buggy, the primary    *)
(* acknowledges as it stores; fixed, once the backup confirms.                   *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

VARIABLES acked, primary, backup, net, acts, faults
vars == <<acked, primary, backup, net, acts, faults>>

Send(t) == SetToBag({[type |-> t]})
Take(m) == net (-) SetToBag({m})

Init == acked = 0 /\ primary = 0 /\ backup = 0 /\ net = EmptyBag /\ acts = 0 /\ faults = 0

Write ==
  /\ acts < Repeats /\ acts' = acts + 1
  /\ net' = net (+) Send("Write")
  /\ UNCHANGED <<acked, primary, backup, faults>>

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<acts, faults>>
  /\ CASE m.type = "Write" ->
            /\ primary' = primary + 1
            /\ net' = Take(m) (+) (IF Buggy THEN Send("Ack") (+) Send("Replicate") ELSE Send("Replicate"))
            /\ UNCHANGED <<acked, backup>>
       [] m.type = "Replicate" ->
            /\ backup' = backup + 1
            /\ net' = IF Buggy THEN Take(m) ELSE Take(m) (+) Send("Replicated")
            /\ UNCHANGED <<acked, primary>>
       [] m.type = "Replicated" ->
            /\ net' = Take(m) (+) Send("Ack")
            /\ UNCHANGED <<acked, primary, backup>>
       [] m.type = "Ack" ->
            /\ acked' = acked + 1 /\ net' = Take(m)
            /\ UNCHANGED <<primary, backup>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<acked, primary, backup, acts>>

\* Either server restarting changes nothing but the budget: their writes are durable.
Restart ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ UNCHANGED <<acked, primary, backup, net, acts>>

Next == Write \/ Restart \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

ackedIsReplicated == acked <= backup
=============================================================================
