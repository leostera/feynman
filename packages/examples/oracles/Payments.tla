------------------------------ MODULE Payments ------------------------------
(* An independent model of specs/payments.ts, with one client. The client's      *)
(* retry timer may fire whenever it is set: the network may be slower than it.  *)
(* `steps` bounds the depth like the checker's; VIEW leaves it out of a state.   *)
EXTENDS Naturals, Bags, FiniteSets, Sequences

CONSTANTS Buggy, Faults, Repeats, Depth

None == 0  \* ids start at 1

VARIABLES balance, debits, seen, paid, pending, timer, fresh, net, acts, faults, steps
vars == <<balance, debits, seen, paid, pending, timer, fresh, net, acts, faults, steps>>
view == <<balance, debits, seen, paid, pending, timer, fresh, net, acts, faults>>

Init ==
  /\ balance = 100 /\ debits = 0 /\ seen = <<>>
  /\ paid = 0 /\ pending = None /\ timer = FALSE
  /\ fresh = 0 /\ net = EmptyBag /\ acts = 0 /\ faults = 0 /\ steps = 0

Pay ==
  /\ pending = None /\ acts < Repeats
  /\ pending' = fresh + 1 /\ fresh' = fresh + 1
  /\ paid' = paid + 1 /\ acts' = acts + 1
  /\ net' = net (+) SetToBag({[type |-> "Debit", id |-> fresh + 1]})
  /\ timer' = TRUE
  /\ UNCHANGED <<balance, debits, seen, faults>>

OnDebit(m) ==
  /\ IF ~Buggy /\ \E i \in 1..Len(seen) : seen[i] = m.id
       THEN UNCHANGED <<balance, debits, seen>>
       ELSE /\ balance' = balance - 10 /\ debits' = debits + 1 /\ seen' = Append(seen, m.id)
  /\ net' = (net (-) SetToBag({m})) (+) SetToBag({[type |-> "Debited", id |-> m.id]})
  /\ UNCHANGED <<paid, pending, timer>>

OnDebited(m) ==
  /\ IF pending = m.id THEN pending' = None /\ timer' = FALSE ELSE UNCHANGED <<pending, timer>>
  /\ net' = net (-) SetToBag({m})
  /\ UNCHANGED <<balance, debits, seen, paid>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ IF m.type = "Debit" THEN OnDebit(m) ELSE OnDebited(m)
  /\ UNCHANGED <<fresh, acts, faults>>

Retry ==
  /\ timer
  /\ IF pending = None
       THEN timer' = FALSE /\ UNCHANGED net
       ELSE timer' = TRUE /\ net' = net (+) SetToBag({[type |-> "Debit", id |-> pending]})
  /\ UNCHANGED <<balance, debits, seen, paid, pending, fresh, acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = net (-) SetToBag({m}) /\ faults' = faults + 1
  /\ UNCHANGED <<balance, debits, seen, paid, pending, timer, fresh, acts>>

(* paid and pending are durable; a restart loses the timer. *)
Restart ==
  /\ faults < Faults
  /\ timer' = FALSE /\ faults' = faults + 1
  /\ UNCHANGED <<balance, debits, seen, paid, pending, fresh, net, acts>>

Next ==
  /\ steps < Depth /\ steps' = steps + 1
  /\ \/ Pay \/ Retry \/ Restart
     \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

debitedOnce == debits <= paid
=============================================================================
