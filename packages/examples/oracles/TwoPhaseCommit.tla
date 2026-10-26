--------------------------- MODULE TwoPhaseCommit ---------------------------
(* An independent model of specs/two-phase-commit.ts, for TLC to check.         *)
(* It follows Feynman's semantics: the network is a bag, any message in it may  *)
(* be delivered next, a fault loses one or restarts a participant, and each      *)
(* action is taken at most Repeats times by each instance. Votes are "yes"/"no",  *)
(* decisions "commit"/"abort", and "none" stands for null.                       *)
EXTENDS Naturals, Bags, FiniteSets

CONSTANTS Buggy, Faults, Repeats

P == {"a", "b"}
C == "coordinator"
None == "none"

VARIABLES prepared, vote, outcome, begun, votes, decided, net, actsBegin, actsVote, faults
vars == <<prepared, vote, outcome, begun, votes, decided, net, actsBegin, actsVote, faults>>

Msg(type, to, from, val) == [type |-> type, to |-> to, from |-> from, val |-> val]
Add(S) == SetToBag(S)
Remove(m) == net (-) SetToBag({m})

Init ==
  /\ prepared = [p \in P |-> FALSE]
  /\ vote = [p \in P |-> None]
  /\ outcome = [p \in P |-> None]
  /\ begun = FALSE
  /\ votes = [p \in P |-> None]
  /\ decided = None
  /\ net = EmptyBag
  /\ actsBegin = 0
  /\ actsVote = [p \in P |-> 0]
  /\ faults = 0

Begin ==
  /\ ~begun /\ actsBegin < Repeats
  /\ begun' = TRUE
  /\ actsBegin' = actsBegin + 1
  /\ net' = net (+) Add({Msg("Prepare", p, C, None) : p \in P})
  /\ UNCHANGED <<prepared, vote, outcome, votes, decided, actsVote, faults>>

Vote(p, choice) ==
  /\ prepared[p] /\ vote[p] = None /\ actsVote[p] < Repeats
  /\ vote' = [vote EXCEPT ![p] = choice]
  /\ outcome' = IF choice = "no" THEN [outcome EXCEPT ![p] = "abort"] ELSE outcome
  /\ actsVote' = [actsVote EXCEPT ![p] = @ + 1]
  /\ net' = net (+) Add({Msg("Vote", C, p, choice)})
  /\ UNCHANGED <<prepared, begun, votes, decided, actsBegin, faults>>

OnPrepare(m) ==
  /\ prepared' = [prepared EXCEPT ![m.to] = TRUE]
  /\ net' = Remove(m)
  /\ UNCHANGED <<vote, outcome, begun, votes, decided>>

OnDecide(m) ==
  /\ outcome' = IF outcome[m.to] = None THEN [outcome EXCEPT ![m.to] = m.val] ELSE outcome
  /\ net' = Remove(m)
  /\ UNCHANGED <<prepared, vote, begun, votes, decided>>

OnVote(m) ==
  LET counted == [votes EXCEPT ![m.from] = m.val]
      all == \A q \in P : counted[q] # None
      decide == Buggy \/ all \/ m.val = "no"
      yes == IF Buggy THEN m.val = "yes" ELSE all /\ \A q \in P : counted[q] = "yes"
      decision == IF yes THEN "commit" ELSE "abort"
  IN /\ votes' = counted
     /\ IF decided = None /\ decide
          THEN /\ decided' = decision
               /\ net' = Remove(m) (+) Add({Msg("Decide", q, C, decision) : q \in P})
          ELSE /\ decided' = decided
               /\ net' = Remove(m)
     /\ UNCHANGED <<prepared, vote, outcome, begun>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ CASE m.type = "Prepare" -> OnPrepare(m)
       [] m.type = "Decide" -> OnDecide(m)
       [] m.type = "Vote" -> OnVote(m)
  /\ UNCHANGED <<actsBegin, actsVote, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Remove(m)
  /\ faults' = faults + 1
  /\ UNCHANGED <<prepared, vote, outcome, begun, votes, decided, actsBegin, actsVote>>

(* Every participant field is durable, so a restart changes nothing but the fault count. *)
Restart(p) ==
  /\ faults < Faults
  /\ faults' = faults + 1
  /\ UNCHANGED <<prepared, vote, outcome, begun, votes, decided, net, actsBegin, actsVote>>

Next ==
  \/ Begin
  \/ \E p \in P, c \in {"yes", "no"} : Vote(p, c)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)
  \/ \E p \in P : Restart(p)

Spec == Init /\ [][Next]_vars

atomic == ~(\E p, q \in P : outcome[p] = "commit" /\ outcome[q] = "abort")
decidedOnceQuiet == (net = EmptyBag /\ \A p \in P : vote[p] # None) => decided # None
=============================================================================
