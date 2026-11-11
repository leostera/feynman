---------------------------- MODULE OrderedWrites ----------------------------
(* An independent model of examples/ordered-writes.ts. The writes in flight are a  *)
(* sequence, oldest first. Buggy: the network reorders, so any may arrive next,    *)
(* and VIEW sees them as a bag. Fixed: one connection, as `ordered: true`, so only *)
(* the oldest may; a loss takes any, and leaves the rest in order.                 *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Buggy, Faults, Repeats

VARIABLES last, value, net, acts, faults
vars == <<last, value, net, acts, faults>>

Range(s) == {s[i] : i \in DOMAIN s}
AsBag(s) == [m \in Range(s) |-> Cardinality({i \in DOMAIN s : s[i] = m})]
view == <<last, value, IF Buggy THEN AsBag(net) ELSE net, acts, faults>>

Without(s, i) == SubSeq(s, 1, i - 1) \o SubSeq(s, i + 1, Len(s))
Arrives == IF Buggy THEN DOMAIN net ELSE (IF net = <<>> THEN {} ELSE {1})

Init == last = "none" /\ value = "none" /\ net = <<>> /\ acts = 0 /\ faults = 0

Set(v) ==
  /\ acts < Repeats /\ acts' = acts + 1
  /\ last' = v /\ net' = Append(net, v)
  /\ UNCHANGED <<value, faults>>

Put(i) ==
  /\ value' = net[i] /\ net' = Without(net, i)
  /\ UNCHANGED <<last, acts, faults>>

Lose(i) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ net' = Without(net, i)
  /\ UNCHANGED <<last, value, acts>>

Next ==
  \/ \E v \in {"a", "b"} : Set(v)
  \/ \E i \in Arrives : Put(i)
  \/ \E i \in DOMAIN net : Lose(i)

lastWriteWins == net = <<>> => value = last
=============================================================================
