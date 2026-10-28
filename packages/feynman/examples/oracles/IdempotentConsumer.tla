------------------------- MODULE IdempotentConsumer -------------------------
(* An independent model of examples/idempotent-consumer.ts: a broker hands one  *)
(* job to a consumer and redelivers it on a timer until it hears back. The      *)
(* consumer charges for a job it does not remember processing. Buggy, what it   *)
(* processed is lost on a restart; fixed, it is durable. The broker never       *)
(* restarts; the consumer has no timers, and messages to it survive a restart.  *)
(* Redelivery has no end while the job is unacknowledged, so the model is       *)
(* bounded by Depth steps, as the checker is, and states are told apart without *)
(* the step count (`view`).                                                      *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats, Depth

Job == "job-1"

VARIABLES published, unacked, timer, processed, charged, net, faults, steps
view == <<published, unacked, timer, processed, charged, net, faults>>

One(m) == SetToBag({m})
Take(m) == net (-) One(m)

Init ==
  /\ published = 0 /\ unacked = {} /\ timer = FALSE
  /\ processed = {} /\ charged = 0
  /\ net = EmptyBag /\ faults = 0 /\ steps = 0

\* `published` also counts the action, which its guard bounds below Repeats.
Publish ==
  /\ published < 1 /\ published < Repeats
  /\ published' = published + 1 /\ unacked' = unacked \cup {Job} /\ timer' = TRUE
  /\ net' = net (+) One([type |-> "Job", job |-> Job])
  /\ UNCHANGED <<processed, charged, faults>>

Redeliver ==
  /\ timer
  /\ IF unacked = {}
       THEN timer' = FALSE /\ UNCHANGED net
       ELSE timer' = TRUE /\ net' = net (+) One([type |-> "Job", job |-> Job])
  /\ UNCHANGED <<published, unacked, processed, charged, faults>>

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<published, faults>>
  /\ CASE m.type = "Job" ->
            /\ net' = Take(m) (+) One([type |-> "Done", job |-> m.job])
            /\ processed' = processed \cup {m.job}
            /\ charged' = IF m.job \in processed THEN charged ELSE charged + 1
            /\ UNCHANGED <<unacked, timer>>
       [] m.type = "Done" ->
            /\ net' = Take(m)
            /\ unacked' = unacked \ {m.job}
            /\ timer' = (timer /\ unacked \ {m.job} # {})
            /\ UNCHANGED <<processed, charged>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<published, unacked, timer, processed, charged>>

RestartConsumer ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ processed' = IF Buggy THEN {} ELSE processed
  /\ UNCHANGED <<published, unacked, timer, charged, net>>

Step == Publish \/ Redeliver \/ RestartConsumer \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

Next == steps < Depth /\ steps' = steps + 1 /\ Step

chargedOnce == charged <= 1
=============================================================================
