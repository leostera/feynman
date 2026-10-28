----------------------------- MODULE ReadRepair -----------------------------
(* An independent model of examples/read-repair.ts: a coordinator writes v1 and *)
(* v2 to three replicas and reads once, from the first two replies, repairing a  *)
(* replier that was behind. Replicas take a put only if newer; buggy, they take  *)
(* a repair as it comes. `highest` is the ghost the invariant reads. Replicas    *)
(* are wholly durable, so a restart changes nothing but the budget; the         *)
(* coordinator never restarts.                                                    *)
EXTENDS Naturals, Bags, FiniteSets

CONSTANTS Buggy, Faults, Repeats

Replicas == {"a", "b", "c"}
None == 99   \* no reply from this replica yet
Max(S) == CHOOSE x \in S : \A y \in S : x >= y

VARIABLES written, reading, replies, read, version, highest, net, faults
vars == <<written, reading, replies, read, version, highest, net, faults>>

One(m) == SetToBag({m})
Take(m) == net (-) One(m)
ToAll(f(_)) == [m \in {f(r) : r \in Replicas} |-> 1]
Repliers == {r \in Replicas : replies[r] # None}

Init ==
  /\ written = 0 /\ reading = FALSE /\ replies = [r \in Replicas |-> None] /\ read = None
  /\ version = [r \in Replicas |-> 0] /\ highest = [r \in Replicas |-> 0]
  /\ net = EmptyBag /\ faults = 0

\* `written` also counts the action, which its guard bounds below Repeats.
Write ==
  /\ written < 2 /\ written < Repeats
  /\ written' = written + 1
  /\ LET Put(r) == [type |-> "Put", to |-> r, version |-> written + 1] IN net' = net (+) ToAll(Put)
  /\ UNCHANGED <<reading, replies, read, version, highest, faults>>

Read ==
  /\ ~reading /\ read = None
  /\ reading' = TRUE
  /\ LET Get(r) == [type |-> "Get", to |-> r] IN net' = net (+) ToAll(Get)
  /\ UNCHANGED <<written, replies, read, version, highest, faults>>

Take2(r, v) ==
  /\ version' = [version EXCEPT ![r] = v]
  /\ highest' = [highest EXCEPT ![r] = IF v > @ THEN v ELSE @]

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<written, faults>>
  /\ CASE m.type = "Put" ->
            /\ net' = Take(m) /\ UNCHANGED <<reading, replies, read>>
            /\ IF m.version > version[m.to] THEN Take2(m.to, m.version) ELSE UNCHANGED <<version, highest>>
       [] m.type = "Repair" ->
            /\ net' = Take(m) /\ UNCHANGED <<reading, replies, read>>
            /\ IF Buggy \/ m.version > version[m.to] THEN Take2(m.to, m.version) ELSE UNCHANGED <<version, highest>>
       [] m.type = "Get" ->
            /\ net' = Take(m) (+) One([type |-> "Got", from |-> m.to, version |-> version[m.to]])
            /\ UNCHANGED <<reading, replies, read, version, highest>>
       [] m.type = "Got" ->
            /\ UNCHANGED <<version, highest>>
            /\ IF ~reading
                 THEN net' = Take(m) /\ UNCHANGED <<reading, replies, read>>
                 ELSE LET now == [replies EXCEPT ![m.from] = m.version]
                          got == {r \in Replicas : now[r] # None}
                          newest == Max({now[r] : r \in got})
                          Repair(r) == [type |-> "Repair", to |-> r, version |-> newest]
                          behind == {r \in got : now[r] < newest}
                      IN IF Cardinality(got) < 2
                           THEN replies' = now /\ net' = Take(m) /\ UNCHANGED <<reading, read>>
                           ELSE /\ net' = Take(m) (+) [x \in {Repair(r) : r \in behind} |-> 1]
                                /\ read' = newest /\ reading' = FALSE
                                /\ replies' = [r \in Replicas |-> None]

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<written, reading, replies, read, version, highest>>

RestartReplica ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ UNCHANGED <<written, reading, replies, read, version, highest, net>>

Next == Write \/ Read \/ RestartReplica \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

neverGoesBack == \A r \in Replicas : version[r] >= highest[r]
=============================================================================
