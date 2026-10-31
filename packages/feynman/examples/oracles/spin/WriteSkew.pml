/* An independent model of examples/write-skew.ts, for SPIN, with two doctors (0 and 1) and a
   roster. Buggy, a doctor asks the roster how many are on call and, when it is two, leaves in
   a second message; fixed, the roster checks and removes in one step. The network is a bag: a
   count of copies per doctor and kind of message; the roster's count travels with the number
   it counted. A fault loses a message, or restarts a doctor, who goes back to "on" in their own
   mind. The harness defines BUGGY, FAULTS and REPEATS. Phases: 0 on, 1 asking, 2 off. */
short onCall = 2;
byte phase[2], acts[2], faults;
byte check[2], leave[2], leaveIf[2], left[2], stay[2];
byte count[10];   /* Count in flight, at doctor * 5 + the number counted + 2 (from -2 to 2) */

inline goOff(d) {
  d_step { phase[d] == 0 && acts[d] < REPEATS -> phase[d] = 1; acts[d]++; if :: BUGGY -> check[d]++ :: else -> leaveIf[d]++ fi }
}
inline onCheck(d) { d_step { check[d] > 0 -> assert(onCall >= -2 && onCall <= 2); check[d]--; count[d * 5 + onCall + 2]++ } }
inline onLeave(d) { d_step { leave[d] > 0 -> leave[d]--; onCall-- } }
inline onLeaveIf(d) { d_step { leaveIf[d] > 0 -> leaveIf[d]--; if :: onCall < 2 -> stay[d]++ :: else -> onCall--; left[d]++ fi } }
inline onCount(d, n) { d_step { count[d * 5 + n + 2] > 0 -> count[d * 5 + n + 2]--; if :: n < 2 -> phase[d] = 0 :: else -> phase[d] = 2; leave[d]++ fi } }
inline onLeft(d) { d_step { left[d] > 0 -> left[d]--; phase[d] = 2 } }
inline onStay(d) { d_step { stay[d] > 0 -> stay[d]--; phase[d] = 0 } }
inline lost(c) { d_step { faults < FAULTS && c > 0 -> c--; faults++ } }
/* What may happen at a doctor, or to the messages to and from them: the options of one loop. */
#define DOCTOR(d) \
  :: goOff(d) :: onCheck(d) :: onLeave(d) :: onLeaveIf(d) :: onLeft(d) :: onStay(d) \
  :: onCount(d, -2) :: onCount(d, -1) :: onCount(d, 0) :: onCount(d, 1) :: onCount(d, 2) \
  :: lost(check[d]) :: lost(leave[d]) :: lost(leaveIf[d]) :: lost(left[d]) :: lost(stay[d]) \
  :: lost(count[d * 5]) :: lost(count[d * 5 + 1]) :: lost(count[d * 5 + 2]) :: lost(count[d * 5 + 3]) :: lost(count[d * 5 + 4]) \
  :: d_step { faults < FAULTS -> phase[d] = 0; faults++ }

active proctype system() {
end:
  do
  DOCTOR(0)
  DOCTOR(1)
  od
}

ltl p_covered { [] (onCall >= 1) }
