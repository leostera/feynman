------------------------------ MODULE TokenRing ------------------------------
(* An independent model of examples/token-ring.ts: nodes a, b, c in a ring, the  *)
(* token starting at a. Unacked is 0 when nothing awaits an acknowledgement.     *)
(* Everything is on disk, so a restart only drops the resend timer. `steps`      *)
(* bounds the depth like the checker's; VIEW leaves it out of a state.           *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats, Depth

Nodes == {"a", "b", "c"}
Succ(n) == CASE n = "a" -> "b" [] n = "b" -> "c" [] n = "c" -> "a"

VARIABLES holds, count, unacked, resend, net, acts, faults, steps
vars == <<holds, count, unacked, resend, net, acts, faults, steps>>
view == <<holds, count, unacked, resend, net, acts, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})
TokenFrom(n, c) == [type |-> "Token", from |-> n, to |-> Succ(n), count |-> c]

Init ==
  /\ holds = [n \in Nodes |-> n = "a"] /\ count = [n \in Nodes |-> 0] /\ unacked = [n \in Nodes |-> 0]
  /\ resend = [n \in Nodes |-> FALSE] /\ net = EmptyBag /\ acts = [n \in Nodes |-> 0] /\ faults = 0 /\ steps = 0

Pass(n) ==
  /\ holds[n] /\ acts[n] < Repeats
  /\ acts' = [acts EXCEPT ![n] = @ + 1]
  /\ holds' = [holds EXCEPT ![n] = FALSE] /\ count' = [count EXCEPT ![n] = @ + 1]
  /\ unacked' = [unacked EXCEPT ![n] = count[n] + 1] /\ resend' = [resend EXCEPT ![n] = TRUE]
  /\ net' = net (+) Send(TokenFrom(n, count[n] + 1))
  /\ UNCHANGED faults

OnToken(m) ==
  /\ IF Buggy \/ m.count > count[m.to]
       THEN holds' = [holds EXCEPT ![m.to] = TRUE] /\ count' = [count EXCEPT ![m.to] = m.count]
       ELSE UNCHANGED <<holds, count>>
  /\ net' = Take(m) (+) Send([type |-> "Ack", from |-> m.to, to |-> m.from, count |-> m.count])
  /\ UNCHANGED <<unacked, resend>>

OnAck(m) ==
  /\ IF unacked[m.to] = m.count
       THEN unacked' = [unacked EXCEPT ![m.to] = 0] /\ resend' = [resend EXCEPT ![m.to] = FALSE]
       ELSE UNCHANGED <<unacked, resend>>
  /\ net' = Take(m)
  /\ UNCHANGED <<holds, count>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ IF m.type = "Token" THEN OnToken(m) ELSE OnAck(m)
  /\ UNCHANGED <<acts, faults>>

Resend(n) ==
  /\ resend[n]
  /\ IF unacked[n] = 0
       THEN resend' = [resend EXCEPT ![n] = FALSE] /\ UNCHANGED net
       ELSE net' = net (+) Send(TokenFrom(n, unacked[n])) /\ UNCHANGED resend
  /\ UNCHANGED <<holds, count, unacked, acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<holds, count, unacked, resend, acts>>

Restart(n) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ resend' = [resend EXCEPT ![n] = FALSE]
  /\ UNCHANGED <<holds, count, unacked, net, acts>>

Next ==
  /\ steps < Depth /\ steps' = steps + 1
  /\ \/ \E n \in Nodes : Pass(n) \/ Resend(n) \/ Restart(n)
     \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

oneToken == \A x, y \in Nodes : holds[x] /\ holds[y] => x = y
=============================================================================
