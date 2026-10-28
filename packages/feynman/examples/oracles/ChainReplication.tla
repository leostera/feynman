-------------------------- MODULE ChainReplication --------------------------
(* An independent model of examples/chain-replication.ts: a head and a tail.     *)
(* Buggy, a read may go to either; fixed, only to the tail. One read at a time.  *)
(* Head and tail may restart, keeping their version; the client does not.        *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

VARIABLES reading, seen, regressed, head, tail, net, acts, faults
vars == <<reading, seen, regressed, head, tail, net, acts, faults>>

Max(a, b) == IF a > b THEN a ELSE b
One(m) == SetToBag({m})
Take(m) == net (-) One(m)
client == <<reading, seen, regressed>>

Init ==
  /\ reading = FALSE /\ seen = 0 /\ regressed = FALSE /\ head = 0 /\ tail = 0
  /\ net = EmptyBag /\ acts = [a \in {"write", "read"} |-> 0] /\ faults = 0

Write ==
  /\ acts["write"] < Repeats /\ acts' = [acts EXCEPT !["write"] = @ + 1]
  /\ net' = net (+) One([type |-> "Write"])
  /\ UNCHANGED <<client, head, tail, faults>>

Read(from) ==
  /\ ~reading /\ acts["read"] < Repeats /\ acts' = [acts EXCEPT !["read"] = @ + 1]
  /\ reading' = TRUE /\ net' = net (+) One([type |-> "Read", to |-> from])
  /\ UNCHANGED <<seen, regressed, head, tail, faults>>

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<acts, faults>>
  /\ CASE m.type = "Write" ->
            /\ head' = head + 1 /\ net' = Take(m) (+) One([type |-> "Update", version |-> head + 1])
            /\ UNCHANGED <<client, tail>>
       [] m.type = "Update" ->
            /\ tail' = Max(tail, m.version) /\ net' = Take(m)
            /\ UNCHANGED <<client, head>>
       [] m.type = "Read" ->
            /\ net' = Take(m) (+) One([type |-> "Value", from |-> m.to, version |-> IF m.to = "head" THEN head ELSE tail])
            /\ UNCHANGED <<client, head, tail>>
       [] m.type = "Value" ->
            /\ reading' = FALSE /\ regressed' = (regressed \/ m.version < seen) /\ seen' = Max(seen, m.version)
            /\ net' = Take(m) /\ UNCHANGED <<head, tail>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<client, head, tail, acts>>

\* Head or tail restarting changes nothing but the budget: their versions are durable.
Restart ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ UNCHANGED <<client, head, tail, net, acts>>

Next ==
  \/ Write \/ Restart
  \/ \E from \in (IF Buggy THEN {"head", "tail"} ELSE {"tail"}) : Read(from)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

monotonicReads == ~regressed
=============================================================================
