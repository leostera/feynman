------------------------------ MODULE LeaseLock ------------------------------
(* An independent model of examples/lease-lock.ts, with two clients. The lease   *)
(* and the stall are timers that may fire at any moment once set: nothing makes  *)
(* a pause shorter than a lease. A token of 0 is none; grants start at 1.        *)
EXTENDS Naturals, Bags, Sequences

CONSTANTS Buggy, Faults, Repeats

Clients == {"a", "b"}
None == "none"

VARIABLES holder, token, expire, accepted, held, asking, writing, net, acts, faults
vars == <<holder, token, expire, accepted, held, asking, writing, net, acts, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})
Newest == IF accepted = <<>> THEN 0 ELSE accepted[Len(accepted)]

Init ==
  /\ holder = None /\ token = 0 /\ expire = FALSE /\ accepted = <<>>
  /\ held = [c \in Clients |-> 0] /\ asking = [c \in Clients |-> FALSE] /\ writing = [c \in Clients |-> FALSE]
  /\ net = EmptyBag /\ acts = [c \in Clients |-> 0] /\ faults = 0

Acquire(c) ==
  /\ held[c] = 0 /\ ~asking[c] /\ acts[c] < Repeats
  /\ asking' = [asking EXCEPT ![c] = TRUE] /\ acts' = [acts EXCEPT ![c] = @ + 1]
  /\ net' = net (+) Send([type |-> "Acquire", from |-> c])
  /\ UNCHANGED <<holder, token, expire, accepted, held, writing, faults>>

OnAcquire(m) ==
  IF holder # None /\ holder # m.from
    THEN /\ net' = Take(m) (+) Send([type |-> "Denied", to |-> m.from])
         /\ UNCHANGED <<holder, token, expire, accepted, held, asking, writing>>
    ELSE /\ holder' = m.from /\ token' = token + 1 /\ expire' = TRUE
         /\ net' = Take(m) (+) Send([type |-> "Granted", to |-> m.from, token |-> token + 1])
         /\ UNCHANGED <<accepted, held, asking, writing>>

OnGranted(m) ==
  /\ asking' = [asking EXCEPT ![m.to] = FALSE] /\ held' = [held EXCEPT ![m.to] = m.token]
  /\ writing' = [writing EXCEPT ![m.to] = TRUE] /\ net' = Take(m)
  /\ UNCHANGED <<holder, token, expire, accepted>>

OnDenied(m) ==
  /\ asking' = [asking EXCEPT ![m.to] = FALSE] /\ net' = Take(m)
  /\ UNCHANGED <<holder, token, expire, accepted, held, writing>>

(* Storage keeps tokens in the order it took them; fenced, it refuses one older than the newest. *)
(* Taken tokens never decrease when fenced, so the last is the newest.                            *)
OnWrite(m) ==
  /\ IF ~Buggy /\ m.token < Newest THEN UNCHANGED accepted ELSE accepted' = Append(accepted, m.token)
  /\ net' = Take(m)
  /\ UNCHANGED <<holder, token, expire, held, asking, writing>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ CASE m.type = "Acquire" -> OnAcquire(m)
       [] m.type = "Granted" -> OnGranted(m)
       [] m.type = "Denied" -> OnDenied(m)
       [] m.type = "Write" -> OnWrite(m)
  /\ UNCHANGED <<acts, faults>>

Expire ==
  /\ expire /\ expire' = FALSE /\ holder' = None
  /\ UNCHANGED <<token, accepted, held, asking, writing, net, acts, faults>>

Write(c) ==
  /\ writing[c] /\ writing' = [writing EXCEPT ![c] = FALSE]
  /\ IF held[c] = 0
       THEN UNCHANGED <<held, net>>
       ELSE /\ net' = net (+) Send([type |-> "Write", from |-> c, token |-> held[c]])
            /\ held' = [held EXCEPT ![c] = 0]
  /\ UNCHANGED <<holder, token, expire, accepted, asking, acts, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<holder, token, expire, accepted, held, asking, writing, acts>>

(* A client forgets everything, and its stall timer is gone. The servers are singletons. *)
Restart(c) ==
  /\ faults < Faults /\ faults' = faults + 1
  /\ held' = [held EXCEPT ![c] = 0] /\ asking' = [asking EXCEPT ![c] = FALSE] /\ writing' = [writing EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<holder, token, expire, accepted, net, acts>>

Next ==
  \/ \E c \in Clients : Acquire(c) \/ Write(c) \/ Restart(c)
  \/ Expire
  \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

fenced == \A i \in 1..Len(accepted) : i = 1 \/ accepted[i] >= accepted[i - 1]
=============================================================================
