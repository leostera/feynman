--------------------------- MODULE LogReplication ---------------------------
(* An independent model of examples/log-replication.ts: a leader appends x, then *)
(* y, sending each to a follower. Buggy, the follower appends whatever arrives;  *)
(* fixed, only the entry that goes right after its last, else it says how far   *)
(* its log reaches and the leader sends that entry. Neither restarts.           *)
EXTENDS Naturals, Sequences, Bags

CONSTANTS Buggy, Faults, Repeats

Entries == <<"x", "y">>

VARIABLES leader, follower, net, acts, faults
vars == <<leader, follower, net, acts, faults>>

One(m) == SetToBag({m})
Take(m) == net (-) One(m)
\* Messages carry 0-based indexes, as the spec's do.
AppendOf(i) == [type |-> "Append", index |-> i, entry |-> leader[i + 1]]

Init == leader = <<>> /\ follower = <<>> /\ net = EmptyBag /\ acts = 0 /\ faults = 0

LeaderAppends ==
  /\ Len(leader) < Len(Entries) /\ acts < Repeats /\ acts' = acts + 1
  /\ leader' = Append(leader, Entries[Len(leader) + 1])
  /\ net' = net (+) One([type |-> "Append", index |-> Len(leader), entry |-> Entries[Len(leader) + 1]])
  /\ UNCHANGED <<follower, faults>>

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<acts, faults, leader>>
  /\ CASE m.type = "Append" ->
            IF Buggy \/ m.index = Len(follower)
              THEN follower' = Append(follower, m.entry) /\ net' = Take(m)
              ELSE net' = Take(m) (+) One([type |-> "Behind", length |-> Len(follower)]) /\ UNCHANGED follower
       [] m.type = "Behind" ->
            /\ net' = IF m.length < Len(leader) THEN Take(m) (+) One(AppendOf(m.length)) ELSE Take(m)
            /\ UNCHANGED follower

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<leader, follower, acts>>

Next == LeaderAppends \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

followerIsPrefix == Len(follower) <= Len(leader) /\ \A i \in 1..Len(follower) : follower[i] = leader[i]
=============================================================================
