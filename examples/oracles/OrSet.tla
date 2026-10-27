------------------------------ MODULE OrSet ------------------------------
(* An independent model of examples/or-set.ts: two replicas sharing a set that   *)
(* holds x or not. Buggy applies adds and removes as they come; fixed is an     *)
(* OR-Set with tombstones: tags <<replica, n>>, removes take the tags seen, and  *)
(* an add whose tag was removed already is ignored. Everything is durable, so a *)
(* restart changes nothing but the budget. A replica's adds so far name its     *)
(* tags, and are counted by `acts`, which bounds each action.                    *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Replicas == {"a", "b"}
Other(r) == CHOOSE o \in Replicas : o # r

VARIABLES has, tags, removed, net, acts, faults
vars == <<has, tags, removed, net, acts, faults>>

Take(m) == net (-) SetToBag({m})
Send(m) == net (+) SetToBag({m})
Contains(r) == IF Buggy THEN has[r] ELSE tags[r] # {}

Init ==
  /\ has = [r \in Replicas |-> FALSE]
  /\ tags = [r \in Replicas |-> {}] /\ removed = [r \in Replicas |-> {}]
  /\ net = EmptyBag /\ faults = 0
  /\ acts = [r \in Replicas |-> [add |-> 0, remove |-> 0]]

Add(r) ==
  LET tag == <<r, acts[r].add + 1>> IN
  /\ acts[r].add < Repeats /\ acts' = [acts EXCEPT ![r].add = @ + 1]
  /\ has' = [has EXCEPT ![r] = TRUE]
  /\ tags' = IF Buggy THEN tags ELSE [tags EXCEPT ![r] = @ \cup {tag}]
  /\ net' = Send([type |-> "Add", to |-> Other(r), tag |-> tag])
  /\ UNCHANGED <<removed, faults>>

Remove(r) ==
  /\ Contains(r) /\ acts[r].remove < Repeats /\ acts' = [acts EXCEPT ![r].remove = @ + 1]
  /\ has' = [has EXCEPT ![r] = FALSE]
  /\ tags' = [tags EXCEPT ![r] = {}]
  /\ removed' = IF Buggy THEN removed ELSE [removed EXCEPT ![r] = @ \cup tags[r]]
  /\ net' = Send([type |-> "Remove", to |-> Other(r), tags |-> tags[r]])
  /\ UNCHANGED faults

Deliver(m) ==
  /\ BagIn(m, net) /\ net' = Take(m) /\ UNCHANGED <<acts, faults>>
  /\ CASE m.type = "Add" ->
            /\ has' = [has EXCEPT ![m.to] = TRUE]
            /\ tags' = IF Buggy \/ m.tag \in removed[m.to] THEN tags ELSE [tags EXCEPT ![m.to] = @ \cup {m.tag}]
            /\ UNCHANGED removed
       [] m.type = "Remove" ->
            /\ has' = [has EXCEPT ![m.to] = FALSE]
            /\ tags' = IF Buggy THEN tags ELSE [tags EXCEPT ![m.to] = @ \ m.tags]
            /\ removed' = IF Buggy THEN removed ELSE [removed EXCEPT ![m.to] = @ \cup m.tags]

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<has, tags, removed, acts>>

Restart ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ UNCHANGED <<has, tags, removed, net, acts>>

Next == \/ \E r \in Replicas : Add(r) \/ Remove(r)
        \/ Restart
        \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

convergesOnceQuiet == net # EmptyBag \/ Contains("a") = Contains("b")
=============================================================================
