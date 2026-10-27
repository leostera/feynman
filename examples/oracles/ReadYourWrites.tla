--------------------------- MODULE ReadYourWrites ---------------------------
(* An independent model of examples/read-your-writes.ts. The follower's held     *)
(* reads are a bag of the write each must see (the spec keeps them sorted, which *)
(* is the same thing). Leader and follower may restart, keeping their version;   *)
(* the follower forgets the reads it held. The client does not restart.          *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

VARIABLES wrote, stale, leader, follower, holding, net, acts, faults
vars == <<wrote, stale, leader, follower, holding, net, acts, faults>>

Max(a, b) == IF a > b THEN a ELSE b
One(m) == SetToBag({m})
Take(m) == net (-) One(m)

Init ==
  /\ wrote = 0 /\ stale = FALSE /\ leader = 0 /\ follower = 0 /\ holding = EmptyBag
  /\ net = EmptyBag /\ acts = [a \in {"write", "read"} |-> 0] /\ faults = 0

Act(a, m) ==
  /\ acts[a] < Repeats /\ acts' = [acts EXCEPT ![a] = @ + 1]
  /\ net' = net (+) One(m)
  /\ UNCHANGED <<wrote, stale, leader, follower, holding, faults>>

Write == Act("write", [type |-> "Write"])
Read == Act("read", [type |-> "Read", atLeast |-> wrote])

\* Answers, at version v, every held read that v satisfies: one Value per read held.
Answered(v) == {a \in BagToSet(holding) : a <= v}
Answers(v) == [m \in {[type |-> "Value", version |-> v, atLeast |-> a] : a \in Answered(v)} |-> holding[m.atLeast]]

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<acts, faults>>
  /\ CASE m.type = "Write" ->
            /\ leader' = leader + 1
            /\ net' = Take(m) (+) One([type |-> "Written", version |-> leader + 1]) (+) One([type |-> "Replicate", version |-> leader + 1])
            /\ UNCHANGED <<wrote, stale, follower, holding>>
       [] m.type = "Written" ->
            /\ wrote' = Max(wrote, m.version) /\ net' = Take(m)
            /\ UNCHANGED <<stale, leader, follower, holding>>
       [] m.type = "Replicate" ->
            LET v == Max(follower, m.version) IN
            /\ follower' = v
            /\ net' = Take(m) (+) Answers(v)
            /\ holding' = [a \in BagToSet(holding) \ Answered(v) |-> holding[a]]
            /\ UNCHANGED <<wrote, stale, leader>>
       [] m.type = "Read" ->
            IF ~Buggy /\ follower < m.atLeast
              THEN /\ holding' = holding (+) One(m.atLeast) /\ net' = Take(m)
                   /\ UNCHANGED <<wrote, stale, leader, follower>>
              ELSE /\ net' = Take(m) (+) One([type |-> "Value", version |-> follower, atLeast |-> m.atLeast])
                   /\ UNCHANGED <<wrote, stale, leader, follower, holding>>
       [] m.type = "Value" ->
            /\ stale' = (stale \/ m.version < m.atLeast) /\ net' = Take(m)
            /\ UNCHANGED <<wrote, leader, follower, holding>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<wrote, stale, leader, follower, holding, acts>>

\* The leader's restart changes nothing but the budget; the follower's forgets the reads it held.
Restart(who) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ holding' = IF who = "follower" THEN EmptyBag ELSE holding
  /\ UNCHANGED <<wrote, stale, leader, follower, net, acts>>

Next == Write \/ Read \/ \E who \in {"leader", "follower"} : Restart(who) \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

readsOwnWrites == ~stale
=============================================================================
