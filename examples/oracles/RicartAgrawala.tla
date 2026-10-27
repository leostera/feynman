--------------------------- MODULE RicartAgrawala ---------------------------
(* An independent model of examples/ricart-agrawala.ts, with nodes a and b (a's *)
(* id sorts first). Asking is 0 when a node is not asking; timestamps start at  *)
(* 1. Fixed: ties go to the smaller id, the clock survives a restart, and an    *)
(* answer counts only for the request it names.                                 *)
EXTENDS Naturals, Bags, Sequences

CONSTANTS Buggy, Faults, Repeats

Nodes == {"a", "b"}
Other(n) == IF n = "a" THEN "b" ELSE "a"
Max(x, y) == IF x > y THEN x ELSE y

VARIABLES clock, asking, oks, inside, deferred, net, acts, faults
vars == <<clock, asking, oks, inside, deferred, net, acts, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})
RECURSIVE BagOf(_)
BagOf(s) == IF s = <<>> THEN EmptyBag ELSE SetToBag({Head(s)}) (+) BagOf(Tail(s))
Answers(n) == [i \in 1..Len(deferred[n]) |-> [type |-> "Ok", from |-> n, to |-> deferred[n][i].id, ts |-> deferred[n][i].ts]]

Init ==
  /\ clock = [n \in Nodes |-> 0] /\ asking = [n \in Nodes |-> 0] /\ oks = [n \in Nodes |-> 0]
  /\ inside = [n \in Nodes |-> FALSE] /\ deferred = [n \in Nodes |-> <<>>]
  /\ net = EmptyBag /\ acts = [a \in Nodes \X {"request", "exit"} |-> 0] /\ faults = 0

Request(n) ==
  /\ asking[n] = 0 /\ ~inside[n] /\ acts[<<n, "request">>] < Repeats
  /\ acts' = [acts EXCEPT ![<<n, "request">>] = @ + 1]
  /\ clock' = [clock EXCEPT ![n] = @ + 1] /\ asking' = [asking EXCEPT ![n] = clock[n] + 1]
  /\ oks' = [oks EXCEPT ![n] = 0]
  /\ net' = net (+) Send([type |-> "Request", from |-> n, to |-> Other(n), ts |-> clock[n] + 1])
  /\ UNCHANGED <<inside, deferred, faults>>

Exit(n) ==
  /\ inside[n] /\ acts[<<n, "exit">>] < Repeats
  /\ acts' = [acts EXCEPT ![<<n, "exit">>] = @ + 1]
  /\ inside' = [inside EXCEPT ![n] = FALSE] /\ asking' = [asking EXCEPT ![n] = 0]
  /\ net' = net (+) BagOf(Answers(n)) /\ deferred' = [deferred EXCEPT ![n] = <<>>]
  /\ UNCHANGED <<clock, oks, faults>>

OnRequest(m) ==
  LET n == m.to
      mineFirst == asking[n] # 0 /\ (asking[n] < m.ts \/ (~Buggy /\ asking[n] = m.ts /\ n = "a"))
  IN /\ clock' = [clock EXCEPT ![n] = Max(@, m.ts)]
     /\ IF inside[n] \/ mineFirst
          THEN deferred' = [deferred EXCEPT ![n] = Append(@, [id |-> m.from, ts |-> m.ts])] /\ net' = Take(m)
          ELSE net' = Take(m) (+) Send([type |-> "Ok", from |-> n, to |-> m.from, ts |-> m.ts]) /\ UNCHANGED deferred
     /\ UNCHANGED <<asking, oks, inside>>

OnOk(m) ==
  LET n == m.to IN
  /\ IF asking[n] = 0 \/ (~Buggy /\ m.ts # asking[n])
       THEN UNCHANGED <<oks, inside>>
       ELSE oks' = [oks EXCEPT ![n] = @ + 1] /\ inside' = [inside EXCEPT ![n] = @ \/ oks[n] + 1 = 1]
  /\ net' = Take(m)
  /\ UNCHANGED <<clock, asking, deferred>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ IF m.type = "Request" THEN OnRequest(m) ELSE OnOk(m)
  /\ UNCHANGED <<acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<clock, asking, oks, inside, deferred, acts>>

Restart(n) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ clock' = IF Buggy THEN [clock EXCEPT ![n] = 0] ELSE clock
  /\ asking' = [asking EXCEPT ![n] = 0] /\ oks' = [oks EXCEPT ![n] = 0]
  /\ inside' = [inside EXCEPT ![n] = FALSE] /\ deferred' = [deferred EXCEPT ![n] = <<>>]
  /\ UNCHANGED <<net, acts>>

Next ==
  \/ \E n \in Nodes : Request(n) \/ Exit(n) \/ Restart(n)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

mutex == ~(inside["a"] /\ inside["b"])
=============================================================================
