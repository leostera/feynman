------------------------------- MODULE Cache -------------------------------
(* An independent model of specs/cache.ts. Every actor is a singleton, so the    *)
(* only faults are lost messages. None, a record no real entry equals, is empty. *)
EXTENDS Naturals, Bags, FiniteSets

CONSTANTS Buggy, Faults, Repeats

None == [value |-> "none", version |-> 0]

VARIABLES value, version, entry, invalidated, loading, net, reads, writes, faults
vars == <<value, version, entry, invalidated, loading, net, reads, writes, faults>>

Send(m) == SetToBag({m})
Take(m) == net (-) SetToBag({m})

Init ==
  /\ value = "a" /\ version = 0
  /\ entry = None /\ invalidated = 0 /\ loading = FALSE
  /\ net = EmptyBag
  /\ reads = 0 /\ writes = 0 /\ faults = 0

Read ==
  /\ reads < Repeats
  /\ reads' = reads + 1
  /\ net' = net (+) Send([type |-> "Get"])
  /\ UNCHANGED <<value, version, entry, invalidated, loading, writes, faults>>

Write(v) ==
  /\ writes < Repeats
  /\ writes' = writes + 1
  /\ net' = net (+) Send([type |-> "Update", value |-> v])
  /\ UNCHANGED <<value, version, entry, invalidated, loading, reads, faults>>

OnGet(m) ==
  IF entry # None \/ loading
    THEN /\ net' = Take(m) /\ UNCHANGED <<value, version, entry, invalidated, loading>>
    ELSE /\ loading' = TRUE /\ net' = Take(m) (+) Send([type |-> "Load"])
         /\ UNCHANGED <<value, version, entry, invalidated>>

OnLoad(m) ==
  /\ net' = Take(m) (+) Send([type |-> "Loaded", value |-> value, version |-> version])
  /\ UNCHANGED <<value, version, entry, invalidated, loading>>

OnLoaded(m) ==
  /\ loading' = FALSE
  /\ entry' = IF ~Buggy /\ m.version < invalidated THEN entry ELSE [value |-> m.value, version |-> m.version]
  /\ net' = Take(m)
  /\ UNCHANGED <<value, version, invalidated>>

OnUpdate(m) ==
  /\ value' = m.value /\ version' = version + 1
  /\ net' = Take(m) (+) Send([type |-> "Invalidate", version |-> version + 1])
  /\ UNCHANGED <<entry, invalidated, loading>>

OnInvalidate(m) ==
  /\ entry' = None
  /\ invalidated' = IF m.version > invalidated THEN m.version ELSE invalidated
  /\ net' = Take(m)
  /\ UNCHANGED <<value, version, loading>>

Deliver(m) ==
  /\ BagIn(m, net)
  /\ CASE m.type = "Get" -> OnGet(m)
       [] m.type = "Load" -> OnLoad(m)
       [] m.type = "Loaded" -> OnLoaded(m)
       [] m.type = "Update" -> OnUpdate(m)
       [] m.type = "Invalidate" -> OnInvalidate(m)
  /\ UNCHANGED <<reads, writes, faults>>

Lose(m) ==
  /\ faults < Faults /\ BagIn(m, net)
  /\ net' = Take(m) /\ faults' = faults + 1
  /\ UNCHANGED <<value, version, entry, invalidated, loading, reads, writes>>

Next == Read \/ \E v \in {"b", "c"} : Write(v) \/ \E m \in DOMAIN net : Deliver(m) \/ Lose(m)

consistentOnceQuiet == net = EmptyBag => (entry = None \/ entry.value = value)
=============================================================================
