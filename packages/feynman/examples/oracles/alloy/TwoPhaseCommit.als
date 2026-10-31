module TwoPhaseCommit
-- An independent model of examples/two-phase-commit.ts, for Alloy 6. A coordinator asks two
-- participants to prepare; each votes; the coordinator decides once it can (fixed) or on the
-- first vote (buggy) and tells everyone. What is in flight is a count of copies of each
-- message (the network is a bag). A fault loses a message, or restarts a participant, which
-- keeps everything it has (its fields are durable), so a restart only spends the budget.
-- Beginning and voting happen at most Repeats times per instance. The harness appends Buggy,
-- Faults and Repeats.

abstract sig P {}
one sig A, B extends P {}
abstract sig Answer {}
one sig Yes, No extends Answer {}
abstract sig Decision {}
one sig Commit, Abort extends Decision {}

one sig W {
  -- Participants
  var prepared: set P,
  var vote: P -> lone Answer,
  var outcome: P -> lone Decision,
  var voted: P -> one Int,
  -- The coordinator
  var begun: set W,
  var begins: one Int,
  var votes: P -> lone Answer,
  var decided: lone Decision,
  -- In flight (a pair's count is changed by removing its row and adding the new one: `++`
  -- would replace every row of p)
  var prepare: P -> one Int,
  var voteMsg: P -> Answer -> one Int,
  var decide: P -> Decision -> one Int,
  var faults: one Int
}

pred init {
  no W.prepared and no W.vote and no W.outcome and (all p: P | W.voted[p] = 0)
  no W.begun and W.begins = 0 and no W.votes and no W.decided
  all p: P | W.prepare[p] = 0 and (all a: Answer | W.voteMsg[p][a] = 0) and (all d: Decision | W.decide[p][d] = 0)
  W.faults = 0
}

pred keepParticipants { W.prepared' = W.prepared and W.vote' = W.vote and W.outcome' = W.outcome and W.voted' = W.voted }
pred keepCoordinator { W.begun' = W.begun and W.begins' = W.begins and W.votes' = W.votes and W.decided' = W.decided }
pred keepPrepare { W.prepare' = W.prepare }
pred keepVoteMsg { W.voteMsg' = W.voteMsg }
pred keepDecide { W.decide' = W.decide }
pred keepFaults { W.faults' = W.faults }

pred begin {
  no W.begun and W.begins < Repeats
  W.begun' = W and W.begins' = plus[W.begins, 1]
  all p: P | W.prepare'[p] = plus[W.prepare[p], 1]
  W.votes' = W.votes and W.decided' = W.decided
  keepParticipants and keepVoteMsg and keepDecide and keepFaults
}

pred castVote[p: P, a: Answer] {
  p in W.prepared and no W.vote[p] and W.voted[p] < Repeats
  W.vote' = W.vote ++ p -> a
  a = No implies W.outcome' = W.outcome ++ p -> Abort else W.outcome' = W.outcome
  W.voted' = W.voted ++ p -> plus[W.voted[p], 1]
  W.voteMsg' = W.voteMsg - p -> a -> Int + p -> a -> plus[W.voteMsg[p][a], 1]
  W.prepared' = W.prepared
  keepCoordinator and keepPrepare and keepDecide and keepFaults
}

pred onPrepare[p: P] {
  W.prepare[p] > 0
  W.prepare' = W.prepare ++ p -> minus[W.prepare[p], 1]
  W.prepared' = W.prepared + p
  W.vote' = W.vote and W.outcome' = W.outcome and W.voted' = W.voted
  keepCoordinator and keepVoteMsg and keepDecide and keepFaults
}

pred onDecide[p: P, d: Decision] {
  W.decide[p][d] > 0
  W.decide' = W.decide - p -> d -> Int + p -> d -> minus[W.decide[p][d], 1]
  no W.outcome[p] implies W.outcome' = W.outcome ++ p -> d else W.outcome' = W.outcome
  W.prepared' = W.prepared and W.vote' = W.vote and W.voted' = W.voted
  keepCoordinator and keepPrepare and keepVoteMsg and keepFaults
}

pred everyoneIn[counted: P -> Answer] { all q: P | some counted[q] }
pred allYes[counted: P -> Answer] { all q: P | counted[q] = Yes }

-- Counts a vote; decides when it can: on every vote (buggy), or once all are in or one is no.
pred onVote[p: P, a: Answer] {
  W.voteMsg[p][a] > 0
  W.voteMsg' = W.voteMsg - p -> a -> Int + p -> a -> minus[W.voteMsg[p][a], 1]
  let counted = W.votes ++ p -> a {
    W.votes' = counted
    (no W.decided and (Buggy or everyoneIn[counted] or a = No)) implies {
      let decision = ((Buggy and a = Yes) or (not Buggy and everyoneIn[counted] and allYes[counted])) implies Commit else Abort {
        W.decided' = decision
        all q: P, d: Decision | W.decide'[q][d] = (d = decision implies plus[W.decide[q][d], 1] else W.decide[q][d])
      }
    } else {
      W.decided' = W.decided and keepDecide
    }
  }
  W.begun' = W.begun and W.begins' = W.begins
  keepParticipants and keepPrepare and keepFaults
}

pred spend { W.faults < Faults and W.faults' = plus[W.faults, 1] }

pred prepareLost[p: P] {
  spend and W.prepare[p] > 0
  W.prepare' = W.prepare ++ p -> minus[W.prepare[p], 1]
  keepParticipants and keepCoordinator and keepVoteMsg and keepDecide
}

pred voteLost[p: P, a: Answer] {
  spend and W.voteMsg[p][a] > 0
  W.voteMsg' = W.voteMsg - p -> a -> Int + p -> a -> minus[W.voteMsg[p][a], 1]
  keepParticipants and keepCoordinator and keepPrepare and keepDecide
}

pred decideLost[p: P, d: Decision] {
  spend and W.decide[p][d] > 0
  W.decide' = W.decide - p -> d -> Int + p -> d -> minus[W.decide[p][d], 1]
  keepParticipants and keepCoordinator and keepPrepare and keepVoteMsg
}

-- Everything a participant has is durable: a restart only spends the budget.
pred crash[p: P] {
  spend
  keepParticipants and keepCoordinator and keepPrepare and keepVoteMsg and keepDecide
}

pred nothing { keepParticipants and keepCoordinator and keepPrepare and keepVoteMsg and keepDecide and keepFaults }

-- One step of the system: what may happen next. The harness checks traces from init.
pred step {
  (begin or nothing
    or (some p: P, a: Answer | castVote[p, a] or onVote[p, a] or voteLost[p, a])
    or (some p: P | onPrepare[p] or prepareLost[p] or crash[p])
    or (some p: P, d: Decision | onDecide[p, d] or decideLost[p, d]))
}

pred quiet { all p: P | W.prepare[p] = 0 and (all a: Answer | W.voteMsg[p][a] = 0) and (all d: Decision | W.decide[p][d] = 0) }

pred atomic { not (some p, q: P | W.outcome[p] = Commit and W.outcome[q] = Abort) }
pred decidedOnceQuiet { (quiet and (all p: P | some W.vote[p])) implies some W.decided }

-- Every integer the model keeps: the harness checks none comes near overflowing.
fun counts: set Int { univ.(W.voted) + W.begins + univ.(W.prepare) + univ.(univ.(W.voteMsg)) + univ.(univ.(W.decide)) + W.faults }
