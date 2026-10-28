------------------------------- MODULE Switch -------------------------------
(* An independent model of specs/switch.ts. `ups` is history: how often it went  *)
(* on. It stays in the state, so TLC tells "on, off" from the start.              *)
EXTENDS Naturals

CONSTANTS Depth

VARIABLES on, ups, steps
vars == <<on, ups, steps>>
view == <<on, ups>>

Init == on = FALSE /\ ups = 0 /\ steps = 0
Up == ~on /\ on' = TRUE /\ ups' = ups + 1
Down == on /\ on' = FALSE /\ UNCHANGED ups
Next == steps < Depth /\ steps' = steps + 1 /\ (Up \/ Down)

onOnce == ups < 2
=============================================================================
