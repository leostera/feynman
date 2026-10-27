------------------------- MODULE DiningPhilosophers -------------------------
(* An independent model of examples/dining-philosophers.ts: Plato and Kant, forks *)
(* 1 and 2. A fork held by someone else queues the request. Everyone is a         *)
(* singleton, so the only faults are lost messages.                              *)
EXTENDS Naturals, Bags, Sequences

CONSTANTS Buggy, Faults, Repeats

Philosophers == {"plato", "kant"}
Forks == {1, 2}
None == "none"
Order(p) == IF p = "plato" \/ ~Buggy THEN <<1, 2>> ELSE <<2, 1>>

VARIABLES holder, queue, phase, meals, net, acts, faults
vars == <<holder, queue, phase, meals, net, acts, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})

Init ==
  /\ holder = [f \in Forks |-> None] /\ queue = [f \in Forks |-> <<>>]
  /\ phase = [p \in Philosophers |-> "thinking"] /\ meals = [p \in Philosophers |-> 0]
  /\ net = EmptyBag /\ acts = [a \in Philosophers \X {"eat", "finish"} |-> 0] /\ faults = 0

Eat(p) ==
  /\ phase[p] = "thinking" /\ acts[<<p, "eat">>] < Repeats
  /\ phase' = [phase EXCEPT ![p] = "first"] /\ acts' = [acts EXCEPT ![<<p, "eat">>] = @ + 1]
  /\ net' = net (+) Send([type |-> "Take", from |-> p, fork |-> Order(p)[1]])
  /\ UNCHANGED <<holder, queue, meals, faults>>

Finish(p) ==
  /\ phase[p] = "eating" /\ acts[<<p, "finish">>] < Repeats
  /\ phase' = [phase EXCEPT ![p] = "thinking"] /\ meals' = [meals EXCEPT ![p] = @ + 1]
  /\ acts' = [acts EXCEPT ![<<p, "finish">>] = @ + 1]
  /\ net' = net (+) SetToBag({[type |-> "Release", from |-> p, fork |-> f] : f \in Forks})
  /\ UNCHANGED <<holder, queue, faults>>

OnTake(m) ==
  /\ IF holder[m.fork] # None
       THEN queue' = [queue EXCEPT ![m.fork] = Append(@, m.from)] /\ net' = Take(m) /\ UNCHANGED holder
       ELSE /\ holder' = [holder EXCEPT ![m.fork] = m.from]
            /\ net' = Take(m) (+) Send([type |-> "Granted", to |-> m.from, fork |-> m.fork])
            /\ UNCHANGED queue
  /\ UNCHANGED <<phase, meals>>

OnRelease(m) ==
  /\ IF queue[m.fork] = <<>>
       THEN holder' = [holder EXCEPT ![m.fork] = None] /\ net' = Take(m) /\ UNCHANGED queue
       ELSE /\ holder' = [holder EXCEPT ![m.fork] = Head(queue[m.fork])]
            /\ queue' = [queue EXCEPT ![m.fork] = Tail(@)]
            /\ net' = Take(m) (+) Send([type |-> "Granted", to |-> Head(queue[m.fork]), fork |-> m.fork])
  /\ UNCHANGED <<phase, meals>>

OnGranted(m) ==
  /\ CASE phase[m.to] = "first" ->
            /\ phase' = [phase EXCEPT ![m.to] = "second"]
            /\ net' = Take(m) (+) Send([type |-> "Take", from |-> m.to, fork |-> Order(m.to)[2]])
       [] phase[m.to] = "second" -> phase' = [phase EXCEPT ![m.to] = "eating"] /\ net' = Take(m)
       [] OTHER -> net' = Take(m) /\ UNCHANGED phase
  /\ UNCHANGED <<holder, queue, meals>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ CASE m.type = "Take" -> OnTake(m)
       [] m.type = "Release" -> OnRelease(m)
       [] m.type = "Granted" -> OnGranted(m)
  /\ UNCHANGED <<acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<holder, queue, phase, meals, acts>>

Next ==
  \/ \E p \in Philosophers : Eat(p) \/ Finish(p)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

noDeadlock == ~(phase["plato"] = "second" /\ phase["kant"] = "second")
=============================================================================
