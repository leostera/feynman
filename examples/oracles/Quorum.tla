------------------------------- MODULE Quorum -------------------------------
(* An independent model of examples/quorum.ts, with three replicas. Writes need  *)
(* W = 2 acknowledgements; reads take R answers, 1 buggy and 2 fixed. Replicas   *)
(* may restart, keeping their version; the client does not restart.              *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Replicas == {"a", "b", "c"}
W == 2
R == IF Buggy THEN 1 ELSE 2

VARIABLES phase, acks, answers, newest, version, net, acts, faults
vars == <<phase, acks, answers, newest, version, net, acts, faults>>

Max(a, b) == IF a > b THEN a ELSE b
One(m) == SetToBag({m})
Take(m) == net (-) One(m)
ToAll(t) == [m \in {[type |-> t, to |-> r] : r \in Replicas} |-> 1]
client == <<phase, acks, answers, newest>>

Init ==
  /\ phase = "idle" /\ acks = 0 /\ answers = 0 /\ newest = 0
  /\ version = [r \in Replicas |-> 0]
  /\ net = EmptyBag /\ acts = [a \in {"write", "read"} |-> 0] /\ faults = 0

Act(a, from, to, t) ==
  /\ phase = from /\ acts[a] < Repeats /\ acts' = [acts EXCEPT ![a] = @ + 1]
  /\ phase' = to /\ net' = net (+) ToAll(t)
  /\ UNCHANGED <<acks, answers, newest, version, faults>>

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<acts, faults>>
  /\ CASE m.type = "Write" ->
            /\ version' = [version EXCEPT ![m.to] = Max(@, 1)]
            /\ net' = Take(m) (+) One([type |-> "Ack", from |-> m.to])
            /\ UNCHANGED client
       [] m.type = "Read" ->
            /\ net' = Take(m) (+) One([type |-> "Value", from |-> m.to, version |-> version[m.to]])
            /\ UNCHANGED <<client, version>>
       [] m.type = "Ack" ->
            /\ net' = Take(m) /\ UNCHANGED <<answers, newest, version>>
            /\ IF phase = "writing"
                 THEN acks' = acks + 1 /\ phase' = IF acks + 1 = W THEN "written" ELSE phase
                 ELSE UNCHANGED <<acks, phase>>
       [] m.type = "Value" ->
            /\ net' = Take(m) /\ UNCHANGED <<acks, version>>
            /\ IF phase = "reading"
                 THEN /\ answers' = answers + 1 /\ newest' = Max(newest, m.version)
                      /\ phase' = IF answers + 1 = R THEN "read" ELSE phase
                 ELSE UNCHANGED <<answers, newest, phase>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<phase, acks, answers, newest, version, acts>>

\* A replica restarting changes nothing but the budget: its version is durable.
Restart ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ UNCHANGED <<phase, acks, answers, newest, version, net, acts>>

Next ==
  \/ Act("write", "idle", "writing", "Write")
  \/ Act("read", "written", "reading", "Read")
  \/ Restart
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

readSeesWrite == phase # "read" \/ newest >= 1
=============================================================================
