----------------------------- MODULE LostUpdate -----------------------------
(* An independent model of examples/lost-update.ts: two tellers withdraw 30 or  *)
(* 80 from an account of 100 by reading the balance and writing it back less    *)
(* the amount. Buggy, the account takes any write; fixed, only one naming the   *)
(* version it holds, else the teller is in conflict and may retry (a guarded    *)
(* step, which no counter bounds). A teller's restart forgets all but what it   *)
(* paid; the account never restarts.                                             *)
EXTENDS Naturals, Bags

CONSTANTS Buggy, Faults, Repeats

Tellers == {"a", "b"}
Opening == 100

VARIABLES status, amount, paid, balance, version, paidOut, net, acts, faults
vars == <<status, amount, paid, balance, version, paidOut, net, acts, faults>>

One(m) == SetToBag({m})
Take(m) == net (-) One(m)
TellerVars == <<status, amount, paid>>
AccountVars == <<balance, version, paidOut>>

Init ==
  /\ status = [t \in Tellers |-> "idle"] /\ amount = [t \in Tellers |-> 0] /\ paid = [t \in Tellers |-> 0]
  /\ balance = Opening /\ version = 0 /\ paidOut = 0
  /\ net = EmptyBag /\ acts = [t \in Tellers |-> 0] /\ faults = 0

Withdraw(t, a) ==
  /\ status[t] = "idle" /\ acts[t] < Repeats /\ acts' = [acts EXCEPT ![t] = @ + 1]
  /\ status' = [status EXCEPT ![t] = "reading"] /\ amount' = [amount EXCEPT ![t] = a]
  /\ net' = net (+) One([type |-> "Get", from |-> t])
  /\ UNCHANGED <<paid, faults>> /\ UNCHANGED AccountVars

Retry(t) ==
  /\ status[t] = "conflict"
  /\ status' = [status EXCEPT ![t] = "reading"]
  /\ net' = net (+) One([type |-> "Get", from |-> t])
  /\ UNCHANGED <<amount, paid, acts, faults>> /\ UNCHANGED AccountVars

Deliver(m) ==
  /\ BagIn(m, net) /\ UNCHANGED <<acts, faults>>
  /\ CASE m.type = "Get" ->
            /\ net' = Take(m) (+) One([type |-> "Balance", to |-> m.from, balance |-> balance, version |-> version])
            /\ UNCHANGED TellerVars /\ UNCHANGED AccountVars
       [] m.type = "Balance" ->
            /\ UNCHANGED <<amount, paid>> /\ UNCHANGED AccountVars
            /\ IF status[m.to] # "reading" THEN net' = Take(m) /\ UNCHANGED status
               ELSE IF m.balance < amount[m.to]
                 THEN status' = [status EXCEPT ![m.to] = "idle"] /\ net' = Take(m)
                 ELSE /\ status' = [status EXCEPT ![m.to] = "writing"]
                      /\ net' = Take(m) (+) One([type |-> "Set", from |-> m.to, balance |-> m.balance - amount[m.to], version |-> m.version, amount |-> amount[m.to]])
       [] m.type = "Set" ->
            /\ UNCHANGED TellerVars
            /\ IF ~Buggy /\ m.version # version
                 THEN net' = Take(m) (+) One([type |-> "Conflict", to |-> m.from]) /\ UNCHANGED AccountVars
                 ELSE /\ balance' = m.balance /\ version' = version + 1 /\ paidOut' = paidOut + m.amount
                      /\ net' = Take(m) (+) One([type |-> "Ok", to |-> m.from])
       [] m.type = "Ok" ->
            /\ net' = Take(m) /\ UNCHANGED amount /\ UNCHANGED AccountVars
            /\ IF status[m.to] = "writing"
                 THEN paid' = [paid EXCEPT ![m.to] = @ + amount[m.to]] /\ status' = [status EXCEPT ![m.to] = "idle"]
                 ELSE UNCHANGED <<paid, status>>
       [] m.type = "Conflict" ->
            /\ net' = Take(m) /\ UNCHANGED <<amount, paid>> /\ UNCHANGED AccountVars
            /\ status' = IF status[m.to] = "writing" THEN [status EXCEPT ![m.to] = "conflict"] ELSE status

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<acts>> /\ UNCHANGED TellerVars /\ UNCHANGED AccountVars

Restart(t) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ status' = [status EXCEPT ![t] = "idle"] /\ amount' = [amount EXCEPT ![t] = 0]
  /\ UNCHANGED <<paid, net, acts>> /\ UNCHANGED AccountVars

Next ==
  \/ \E t \in Tellers : Retry(t) \/ Restart(t) \/ \E a \in {30, 80} : Withdraw(t, a)
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

moneyAddsUp == balance + paidOut = Opening
=============================================================================
