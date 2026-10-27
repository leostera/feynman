--------------------------- MODULE AlternatingBit ---------------------------
(* An independent model of examples/alternating-bit.ts. The network is a bag, so *)
(* it reorders; buggy tags items with one alternating bit, fixed with their      *)
(* position. The retry timer may fire whenever it is set. `steps` bounds the     *)
(* depth like the checker's; VIEW leaves it out of a state.                      *)
EXTENDS Naturals, Bags, Sequences

CONSTANTS Buggy, Faults, Repeats, Depth

Items == <<"x", "y">>
Tag(position) == IF Buggy THEN position % 2 ELSE position

VARIABLES next, started, retry, delivered, net, acts, faults, steps
vars == <<next, started, retry, delivered, net, acts, faults, steps>>
view == <<next, started, retry, delivered, net, acts, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})
Data(position) == [type |-> "Data", tag |-> Tag(position), value |-> Items[position + 1]]

Init ==
  /\ next = 0 /\ started = FALSE /\ retry = FALSE /\ delivered = <<>>
  /\ net = EmptyBag /\ acts = 0 /\ faults = 0 /\ steps = 0

Start ==
  /\ ~started /\ acts < Repeats
  /\ started' = TRUE /\ acts' = acts + 1 /\ retry' = TRUE
  /\ net' = net (+) Send(Data(0))
  /\ UNCHANGED <<next, delivered, faults>>

OnData(m) ==
  /\ delivered' = IF m.tag = Tag(Len(delivered)) THEN Append(delivered, m.value) ELSE delivered
  /\ net' = Take(m) (+) Send([type |-> "Ack", tag |-> m.tag])
  /\ UNCHANGED <<next, started, retry>>

OnAck(m) ==
  IF next >= Len(Items) \/ m.tag # Tag(next)
    THEN /\ net' = Take(m) /\ UNCHANGED <<next, started, retry, delivered>>
    ELSE /\ next' = next + 1
         /\ IF next + 1 = Len(Items)
              THEN retry' = FALSE /\ net' = Take(m)
              ELSE retry' = TRUE /\ net' = Take(m) (+) Send(Data(next + 1))
         /\ UNCHANGED <<started, delivered>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ IF m.type = "Data" THEN OnData(m) ELSE OnAck(m)
  /\ UNCHANGED <<acts, faults>>

Retry ==
  /\ retry
  /\ IF next >= Len(Items)
       THEN retry' = FALSE /\ UNCHANGED net
       ELSE retry' = TRUE /\ net' = net (+) Send(Data(next))
  /\ UNCHANGED <<next, started, delivered, acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<next, started, retry, delivered, acts>>

(* Both ends are singletons: the only faults are lost messages. *)
Next ==
  /\ steps < Depth /\ steps' = steps + 1
  /\ \/ Start \/ Retry
     \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

inStep == next <= Len(delivered)
inOrder == Len(delivered) <= Len(Items) /\ \A i \in 1..Len(delivered) : delivered[i] = Items[i]
=============================================================================
