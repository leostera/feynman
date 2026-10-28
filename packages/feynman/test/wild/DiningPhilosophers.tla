---------------------------- MODULE DiningPhilosophers ----------------------------
\* From tlaplus/Examples (MIT), specifications/DiningPhilosophers:
\* https://github.com/tlaplus/Examples/tree/master/specifications/DiningPhilosophers
\* Added for Feynman's oracle: StrongSpec and WeakSpec, fair per action, and Starve1..5.

EXTENDS Naturals, FiniteSets

CONSTANT N \* Number of philosophers
ASSUME NIsPosNat == N \in Nat \ {0}

P == 1..N

LeftFork(p) == p
RightFork(p) == (p % N) + 1

ASSUME ForksDistinct == \A p \in P : RightFork(p) \in P /\ RightFork(p) # LeftFork(p)
ASSUME ForksCovered == {RightFork(p) : p \in P} = P

VARIABLES philosophers, forks
vars == <<philosophers, forks>>

TypeOK ==
    /\ philosophers \in [P -> SUBSET P]
    /\ forks \in SUBSET P

Init ==
    \* each philosopher starts with no forks
    /\ philosophers = [ p \in P |-> {} ]
    \* all forks are available
    /\ forks = 1..N

TakeLeft(p) ==
    \* Even philosophers grab the right fork first.
    /\ p % 2 = 0 => philosophers[p] = {RightFork(p)}
    /\ LeftFork(p) \in forks
    /\ forks' = forks \ {LeftFork(p)}
    /\ philosophers' = 
        [philosophers EXCEPT ![p] = philosophers[p] \cup {LeftFork(p)}]

TakeRight(p) ==
    \* Odd philosophers grab the left fork first.
    /\ p % 2 = 1 => philosophers[p] = {LeftFork(p)}
    /\ RightFork(p) \in forks 
    /\ forks' = forks \ {RightFork(p)}
    /\ philosophers' = 
        [philosophers EXCEPT ![p] = philosophers[p] \cup {RightFork(p)}]

Release(p) ==
    /\ philosophers[p] = {LeftFork(p), RightFork(p)}
    /\ forks' = forks \cup {LeftFork(p), RightFork(p)}
    /\ philosophers' = [philosophers EXCEPT ![p] = {}]

Next ==
    \E p \in P:
        \/ TakeLeft(p)
        \/ TakeRight(p)
        \/ Release(p)

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A p \in P :
        SF_vars(TakeLeft(p) \/ TakeRight(p) \/ Release(p))

\* Feynman's fairness is per step, so here each action is fair on its own, strongly or
\* weakly. (The original is strongly fair per philosopher, over all three actions.)
StrongSpec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A p \in P : SF_vars(TakeLeft(p)) /\ SF_vars(TakeRight(p)) /\ SF_vars(Release(p))

WeakSpec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A p \in P : WF_vars(TakeLeft(p)) /\ WF_vars(TakeRight(p)) /\ WF_vars(Release(p))

IsEating(p) ==
    Cardinality(philosophers[p]) = 2

NoDeadlock ==
    ENABLED Next

NoLivelock ==
    []<>(\E p \in P: IsEating(p))

NoStarvation ==
    \A p \in P: []<>IsEating(p)

\* Proved in DiningPhilosophers_proof.
THEOREM DeadlockFreedom == Spec => []NoDeadlock
THEOREM LivelockFreedom == Spec => NoLivelock
THEOREM StarvationFreedom == Spec => NoStarvation

-----

Alias ==
    LET ThinkHungryEat(p) ==
        IF IsEating(p) THEN "eating"
        ELSE IF Cardinality(philosophers[p]) = 1 THEN "hungry"
        ELSE "thinking" IN
    [
        philosophers |-> philosophers,
        forks |-> forks,
        eating |-> [ p \in DOMAIN philosophers |-> ThinkHungryEat(p) ]
    ]

-----------------------------------------------------------------------------


Starve1 == []<>IsEating(1)
Starve2 == []<>IsEating(2)
Starve3 == []<>IsEating(3)
Starve4 == []<>IsEating(4)
Starve5 == []<>IsEating(5)

=============================================================================
