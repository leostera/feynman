------------------------ MODULE AlternatingBitOrdered ------------------------
(* An independent model of examples/alternating-bit.ts with one alternating bit,  *)
(* on two kinds of link. Each direction is a sequence of messages, oldest first:  *)
(* Data from the sender to the receiver, Ack back. Buggy: the link reorders, so    *)
(* any message in flight may arrive next, and VIEW sees each direction as a bag.  *)
(* Fixed: the link keeps order, as `ordered: true` does, so only the oldest may   *)
(* arrive; a loss takes any. The retry timer may fire whenever it is set. `steps` *)
(* bounds the depth like the checker's; VIEW leaves it out of a state.            *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Buggy, Faults, Repeats, Depth

Items == <<"x", "y">>
Tag(position) == position % 2

VARIABLES next, started, retry, delivered, toReceiver, toSender, acts, faults, steps
vars == <<next, started, retry, delivered, toReceiver, toSender, acts, faults, steps>>

(* A sequence as a bag: how many times each message is in it. *)
Range(s) == {s[i] : i \in DOMAIN s}
AsBag(s) == [m \in Range(s) |-> Cardinality({i \in DOMAIN s : s[i] = m})]
Link(s) == IF Buggy THEN AsBag(s) ELSE s
view == <<next, started, retry, delivered, Link(toReceiver), Link(toSender), acts, faults>>

Without(s, i) == SubSeq(s, 1, i - 1) \o SubSeq(s, i + 1, Len(s))
(* Which message in flight may arrive next: any, on a link that reorders; the oldest, on one that does not. *)
Arrives(s) == IF Buggy THEN DOMAIN s ELSE (IF s = <<>> THEN {} ELSE {1})
Data(position) == [tag |-> Tag(position), value |-> Items[position + 1]]

Init ==
  /\ next = 0 /\ started = FALSE /\ retry = FALSE /\ delivered = <<>>
  /\ toReceiver = <<>> /\ toSender = <<>> /\ acts = 0 /\ faults = 0 /\ steps = 0

Start ==
  /\ ~started /\ acts < Repeats
  /\ started' = TRUE /\ acts' = acts + 1 /\ retry' = TRUE
  /\ toReceiver' = Append(toReceiver, Data(0))
  /\ UNCHANGED <<next, delivered, toSender, faults>>

(* The receiver keeps an item whose tag it expects next, and acknowledges the tag either way. *)
OnData(i) ==
  LET m == toReceiver[i] IN
  /\ delivered' = IF m.tag = Tag(Len(delivered)) THEN Append(delivered, m.value) ELSE delivered
  /\ toReceiver' = Without(toReceiver, i)
  /\ toSender' = Append(toSender, m.tag)
  /\ UNCHANGED <<next, started, retry, acts, faults>>

(* The sender moves on on an acknowledgement of its current item's tag. *)
OnAck(i) ==
  LET tag == toSender[i] IN
  /\ toSender' = Without(toSender, i)
  /\ IF next >= Len(Items) \/ tag # Tag(next)
       THEN UNCHANGED <<next, retry, toReceiver>>
       ELSE /\ next' = next + 1
            /\ IF next + 1 = Len(Items)
                 THEN retry' = FALSE /\ UNCHANGED toReceiver
                 ELSE retry' = TRUE /\ toReceiver' = Append(toReceiver, Data(next + 1))
  /\ UNCHANGED <<started, delivered, acts, faults>>

Retry ==
  /\ retry
  /\ IF next >= Len(Items)
       THEN retry' = FALSE /\ UNCHANGED toReceiver
       ELSE retry' = TRUE /\ toReceiver' = Append(toReceiver, Data(next))
  /\ UNCHANGED <<next, started, delivered, toSender, acts, faults>>

(* A loss takes any message in flight, on either link, and leaves the rest in order. *)
LoseData(i) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ toReceiver' = Without(toReceiver, i)
  /\ UNCHANGED <<next, started, retry, delivered, toSender, acts>>

LoseAck(i) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ toSender' = Without(toSender, i)
  /\ UNCHANGED <<next, started, retry, delivered, toReceiver, acts>>

Next ==
  /\ steps < Depth /\ steps' = steps + 1
  /\ \/ Start \/ Retry
     \/ \E i \in Arrives(toReceiver) : OnData(i)
     \/ \E i \in Arrives(toSender) : OnAck(i)
     \/ \E i \in DOMAIN toReceiver : LoseData(i)
     \/ \E i \in DOMAIN toSender : LoseAck(i)

inStep == next <= Len(delivered)
inOrder == Len(delivered) <= Len(Items) /\ \A i \in 1..Len(delivered) : delivered[i] = Items[i]
=============================================================================
