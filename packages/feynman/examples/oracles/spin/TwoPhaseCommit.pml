/* An independent model of examples/two-phase-commit.ts, for SPIN. A coordinator asks two
   participants (0 and 1) to prepare; each votes; the coordinator decides once it can (fixed)
   or on the first vote (buggy) and tells everyone. The network is a bag: a count of copies of
   each message. A fault loses a message, or restarts a participant, which keeps everything (its
   fields are durable): a restart only spends the budget. The harness defines BUGGY, FAULTS
   and REPEATS. Votes are 1 (yes) and 2 (no), decisions 1 (commit) and 2 (abort), 0 none. */
bool prepared[2];
byte vote[2], outcome[2], actsVote[2];
bool begun;
byte votes[2], decided, actsBegin, faults;
byte prepare[2];   /* Prepare in flight, by participant */
byte voteMsg[4];   /* Vote in flight, at participant * 2 + vote - 1 */
byte decide[4];    /* Decide in flight, at participant * 2 + decision - 1 */

inline castVote(p, a) {
  d_step { prepared[p] && vote[p] == 0 && actsVote[p] < REPEATS ->
    vote[p] = a; if :: a == 2 -> outcome[p] = 2 :: else -> skip fi; actsVote[p]++; voteMsg[p * 2 + a - 1]++ }
}
inline onPrepare(p) { d_step { prepare[p] > 0 -> prepare[p]--; prepared[p] = 1 } }
inline onDecide(p, d) { d_step { decide[p * 2 + d - 1] > 0 -> decide[p * 2 + d - 1]--; if :: outcome[p] == 0 -> outcome[p] = d :: else -> skip fi } }
/* Counts a vote; decides on every vote (buggy), or once all are in or one is no. */
inline onVote(p, a) {
  d_step { voteMsg[p * 2 + a - 1] > 0 -> voteMsg[p * 2 + a - 1]--; votes[p] = a;
    if
    :: decided == 0 && (BUGGY || (votes[0] != 0 && votes[1] != 0) || a == 2) ->
       if
       :: (BUGGY && a == 1) || (!BUGGY && votes[0] == 1 && votes[1] == 1) -> decided = 1
       :: else -> decided = 2
       fi;
       decide[decided - 1]++; decide[2 + decided - 1]++
    :: else -> skip
    fi }
}
inline lost(count) { d_step { faults < FAULTS && count > 0 -> count--; faults++ } }

active proctype system() {
end:
  do
  :: d_step { !begun && actsBegin < REPEATS -> begun = 1; actsBegin++; prepare[0]++; prepare[1]++ }
  :: castVote(0, 1)
  :: castVote(0, 2)
  :: castVote(1, 1)
  :: castVote(1, 2)
  :: onPrepare(0)
  :: onPrepare(1)
  :: onVote(0, 1)
  :: onVote(0, 2)
  :: onVote(1, 1)
  :: onVote(1, 2)
  :: onDecide(0, 1)
  :: onDecide(0, 2)
  :: onDecide(1, 1)
  :: onDecide(1, 2)
  :: lost(prepare[0])
  :: lost(prepare[1])
  :: lost(voteMsg[0])
  :: lost(voteMsg[1])
  :: lost(voteMsg[2])
  :: lost(voteMsg[3])
  :: lost(decide[0])
  :: lost(decide[1])
  :: lost(decide[2])
  :: lost(decide[3])
  /* A participant restarts: everything is durable, so it only spends the budget. */
  :: d_step { faults < FAULTS -> faults++ }
  od
}

#define QUIET (prepare[0] + prepare[1] + voteMsg[0] + voteMsg[1] + voteMsg[2] + voteMsg[3] + decide[0] + decide[1] + decide[2] + decide[3] == 0)
ltl p_atomic { [] !((outcome[0] == 1 && outcome[1] == 2) || (outcome[0] == 2 && outcome[1] == 1)) }
ltl p_decidedOnceQuiet { [] (!(QUIET && vote[0] != 0 && vote[1] != 0) || decided != 0) }
