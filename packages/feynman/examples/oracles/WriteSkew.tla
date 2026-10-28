------------------------------ MODULE WriteSkew ------------------------------
(* An independent model of examples/write-skew.ts, with two doctors. Buggy, a     *)
(* doctor checks the count and leaves in two messages; fixed, the roster checks  *)
(* and removes in one. A restart puts a doctor back to "on" in their own mind.   *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Doctors == {"a", "b"}

VARIABLES onCall, phase, net, acts, faults
vars == <<onCall, phase, net, acts, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})
Set(d, p) == phase' = [phase EXCEPT ![d] = p]

Init ==
  /\ onCall = 2 /\ phase = [d \in Doctors |-> "on"]
  /\ net = EmptyBag /\ acts = [d \in Doctors |-> 0] /\ faults = 0

GoOff(d) ==
  /\ phase[d] = "on" /\ acts[d] < Repeats
  /\ Set(d, "asking") /\ acts' = [acts EXCEPT ![d] = @ + 1]
  /\ net' = net (+) Send([type |-> IF Buggy THEN "Check" ELSE "LeaveIfCovered", from |-> d])
  /\ UNCHANGED <<onCall, faults>>

OnRoster(m) ==
  CASE m.type = "Check" ->
         net' = Take(m) (+) Send([type |-> "Count", to |-> m.from, onCall |-> onCall]) /\ UNCHANGED onCall
    [] m.type = "Leave" ->
         onCall' = onCall - 1 /\ net' = Take(m)
    [] m.type = "LeaveIfCovered" ->
         IF onCall < 2
           THEN net' = Take(m) (+) Send([type |-> "Stay", to |-> m.from]) /\ UNCHANGED onCall
           ELSE onCall' = onCall - 1 /\ net' = Take(m) (+) Send([type |-> "Left", to |-> m.from])

OnDoctor(m) ==
  /\ UNCHANGED onCall
  /\ CASE m.type = "Count" ->
            IF m.onCall < 2
              THEN Set(m.to, "on") /\ net' = Take(m)
              ELSE Set(m.to, "off") /\ net' = Take(m) (+) Send([type |-> "Leave", from |-> m.to])
       [] m.type = "Left" -> Set(m.to, "off") /\ net' = Take(m)
       [] m.type = "Stay" -> Set(m.to, "on") /\ net' = Take(m)

Deliver(m) ==
  /\ BagIn(m, net)
  /\ IF m.type \in {"Check", "Leave", "LeaveIfCovered"} THEN OnRoster(m) /\ UNCHANGED phase ELSE OnDoctor(m)
  /\ UNCHANGED <<acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<onCall, phase, acts>>

Restart(d) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ Set(d, "on")
  /\ UNCHANGED <<onCall, net, acts>>

Next ==
  \/ \E d \in Doctors : GoOff(d) \/ Restart(d)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

covered == onCall >= 1
=============================================================================
