------------------------------ MODULE JobQueue ------------------------------
(* An independent model of specs/job-queue.ts. All actors are singletons, so     *)
(* faults are lost messages. `effectsSent` is history, for the `never` property; *)
(* VIEW leaves it and `steps` out of a state, as the checker's dedup does.       *)
EXTENDS Naturals, Bags, FiniteSets, Sequences

CONSTANTS Buggy, Faults, Repeats, Depth

None == 0  \* ids start at 1

VARIABLES pending, enqueued, timer, inbox, done, effects, fresh, net, acts, faults, effectsSent, steps
vars == <<pending, enqueued, timer, inbox, done, effects, fresh, net, acts, faults, effectsSent, steps>>
view == <<pending, enqueued, timer, inbox, done, effects, fresh, net, acts, faults>>

Init ==
  /\ pending = None /\ enqueued = 0 /\ timer = FALSE
  /\ inbox = <<>> /\ done = <<>> /\ effects = 0
  /\ fresh = 0 /\ net = EmptyBag /\ acts = 0 /\ faults = 0 /\ effectsSent = 0 /\ steps = 0

Enqueue ==
  /\ pending = None /\ acts < Repeats
  /\ enqueued' = enqueued + 1 /\ acts' = acts + 1
  /\ pending' = fresh + 1 /\ fresh' = fresh + 1
  /\ net' = net (+) SetToBag({[type |-> "Job", id |-> fresh + 1]})
  /\ timer' = TRUE
  /\ UNCHANGED <<inbox, done, effects, faults, effectsSent>>

Redeliver ==
  /\ timer
  /\ IF pending = None
       THEN timer' = FALSE /\ UNCHANGED net
       ELSE timer' = TRUE /\ net' = net (+) SetToBag({[type |-> "Job", id |-> pending]})
  /\ UNCHANGED <<pending, enqueued, inbox, done, effects, fresh, acts, faults, effectsSent>>

IsDone(id) == \E i \in 1..Len(done) : done[i] = id

Work ==
  /\ Len(inbox) > 0
  /\ LET id == Head(inbox) IN
       /\ inbox' = Tail(inbox)
       /\ IF Buggy \/ ~IsDone(id)
            THEN /\ done' = Append(done, id) /\ effectsSent' = effectsSent + 1
                 /\ net' = net (+) SetToBag({[type |-> "Effect", id |-> id], [type |-> "Ack", id |-> id]})
            ELSE /\ UNCHANGED <<done, effectsSent>>
                 /\ net' = net (+) SetToBag({[type |-> "Ack", id |-> id]})
  /\ UNCHANGED <<pending, enqueued, timer, effects, fresh, acts, faults>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ net' = net (-) SetToBag({m})
  /\ CASE m.type = "Job" -> inbox' = Append(inbox, m.id) /\ UNCHANGED <<pending, timer, effects>>
       [] m.type = "Effect" -> effects' = effects + 1 /\ UNCHANGED <<pending, timer, inbox>>
       [] m.type = "Ack" -> /\ IF pending = m.id THEN pending' = None /\ timer' = FALSE ELSE UNCHANGED <<pending, timer>>
                            /\ UNCHANGED <<inbox, effects>>
  /\ UNCHANGED <<enqueued, done, fresh, acts, faults, effectsSent>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = net (-) SetToBag({m}) /\ faults' = faults + 1
  /\ UNCHANGED <<pending, enqueued, timer, inbox, done, effects, fresh, acts, effectsSent>>

Next ==
  /\ steps < Depth /\ steps' = steps + 1
  /\ \/ Enqueue \/ Redeliver \/ Work
     \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

doneOnce == effectsSent <= enqueued
=============================================================================
