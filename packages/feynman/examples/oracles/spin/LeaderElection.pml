/* An independent model of examples/leader-election.ts, for SPIN. Three nodes, 0 to 2, with
   ids 1 to 3, each announce themselves to the others; a node takes a heard id as its leader
   when it is higher (fixed) or always (buggy). The network is a bag: a count of copies per
   receiver and sender. A fault loses an announcement, or restarts a node, which forgets
   everything (no field is durable) but not how often it has announced. The harness defines
   BUGGY, FAULTS and REPEATS. A node's leader is kept as its id less the node's own, so every
   node starts at 0 and one process is the whole system: the same states, told apart alike. */
short rel[3];
#define LEADER(n) (rel[n] + n + 1)
bool announced[3];
byte acts[3], faults;
byte net[9];   /* announcements in flight, at receiver * 3 + sender */

inline announce(n, a, b) {
  d_step { !announced[n] && acts[n] < REPEATS -> announced[n] = 1; acts[n]++; net[a * 3 + n]++; net[b * 3 + n]++ }
}
inline deliver(to, from) {
  d_step { net[to * 3 + from] > 0 -> net[to * 3 + from]--; if :: BUGGY || from + 1 > LEADER(to) -> rel[to] = from - to :: else -> skip fi }
}
inline lose(to, from) { d_step { faults < FAULTS && net[to * 3 + from] > 0 -> net[to * 3 + from]--; faults++ } }
inline restart(n) { d_step { faults < FAULTS -> rel[n] = 0; announced[n] = 0; faults++ } }

active proctype system() {
end:
  do
  :: announce(0, 1, 2)
  :: announce(1, 0, 2)
  :: announce(2, 0, 1)
  :: deliver(0, 1)
  :: deliver(0, 2)
  :: deliver(1, 0)
  :: deliver(1, 2)
  :: deliver(2, 0)
  :: deliver(2, 1)
  :: lose(0, 1)
  :: lose(0, 2)
  :: lose(1, 0)
  :: lose(1, 2)
  :: lose(2, 0)
  :: lose(2, 1)
  :: restart(0)
  :: restart(1)
  :: restart(2)
  od
}

#define QUIET (net[1] + net[2] + net[3] + net[5] + net[6] + net[7] == 0)
ltl p_agreeOnceQuiet { [] (!(QUIET && announced[0] && announced[1] && announced[2]) || (LEADER(0) == LEADER(1) && LEADER(1) == LEADER(2))) }
