------------------------------ MODULE RaftVote ------------------------------
(* An independent model of examples/raft-vote.ts, with three nodes and one term. *)
(* A restart forgets a node's votes and leadership, and, buggy, its own vote.    *)
EXTENDS Naturals, Bags, FiniteSets, Sequences

CONSTANTS Buggy, Faults, Repeats

Nodes == {"a", "b", "c"}
None == "none"

VARIABLES votedFor, votes, leader, net, acts, faults
vars == <<votedFor, votes, leader, net, acts, faults>>

Take(m) == net (-) SetToBag({m})
Has(s, x) == \E i \in 1..Len(s) : s[i] = x

Init ==
  /\ votedFor = [n \in Nodes |-> None] /\ votes = [n \in Nodes |-> <<>>] /\ leader = [n \in Nodes |-> FALSE]
  /\ net = EmptyBag /\ acts = [n \in Nodes |-> 0] /\ faults = 0

Campaign(n) ==
  /\ votedFor[n] = None /\ acts[n] < Repeats
  /\ votedFor' = [votedFor EXCEPT ![n] = n] /\ votes' = [votes EXCEPT ![n] = <<n>>]
  /\ acts' = [acts EXCEPT ![n] = @ + 1]
  /\ net' = net (+) SetToBag({[type |-> "RequestVote", from |-> n, to |-> o] : o \in Nodes \ {n}})
  /\ UNCHANGED <<leader, faults>>

OnRequestVote(m) ==
  IF votedFor[m.to] # None
    THEN net' = Take(m) /\ UNCHANGED <<votedFor, votes, leader>>
    ELSE /\ votedFor' = [votedFor EXCEPT ![m.to] = m.from]
         /\ net' = Take(m) (+) SetToBag({[type |-> "Vote", from |-> m.to, to |-> m.from]})
         /\ UNCHANGED <<votes, leader>>

OnVote(m) ==
  IF Has(votes[m.to], m.from)
    THEN net' = Take(m) /\ UNCHANGED <<votedFor, votes, leader>>
    ELSE /\ votes' = [votes EXCEPT ![m.to] = Append(@, m.from)]
         /\ leader' = [leader EXCEPT ![m.to] = @ \/ Len(votes[m.to]) + 1 >= 2]
         /\ net' = Take(m)
         /\ UNCHANGED votedFor

Deliver(m) ==
  /\ BagIn(m, net)
  /\ IF m.type = "RequestVote" THEN OnRequestVote(m) ELSE OnVote(m)
  /\ UNCHANGED <<acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<votedFor, votes, leader, acts>>

(* Fixed, the vote is on disk and survives; nothing else does. *)
Restart(n) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ votedFor' = IF Buggy THEN [votedFor EXCEPT ![n] = None] ELSE votedFor
  /\ votes' = [votes EXCEPT ![n] = <<>>] /\ leader' = [leader EXCEPT ![n] = FALSE]
  /\ UNCHANGED <<net, acts>>

Next ==
  \/ \E n \in Nodes : Campaign(n) \/ Restart(n)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

oneLeader == Cardinality({n \in Nodes : leader[n]}) <= 1
=============================================================================
