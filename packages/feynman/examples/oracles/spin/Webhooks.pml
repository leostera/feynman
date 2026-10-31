/* An independent model of examples/webhooks.ts, for SPIN. A provider sends two events, in
   order; the shop credits each, skipping the last event seen (buggy) or any event seen before
   (fixed), which it keeps as a list in the order it credited them. The network is a bag: a
   count of copies per event. A fault duplicates an event in flight or loses one. The harness
   defines BUGGY, FAULTS and REPEATS. */
byte sent, acts, balance, faults;
byte last;          /* 0: none; else the event, 1 or 2 */
byte seen[2];       /* the events credited, in order; 0 past the end */
byte net[3];        /* copies in flight of event 1 and event 2 (net[0] unused) */

#define SEEN(e) (seen[0] == e || seen[1] == e)

active proctype system() {
end:
  do
  :: d_step { sent < 2 && acts < REPEATS -> sent++; acts++; net[sent]++ }
  :: d_step { net[1] > 0 -> net[1]--;
       if
       :: BUGGY && last != 1 -> balance = balance + 10; last = 1
       :: !BUGGY && !SEEN(1) -> balance = balance + 10; if :: seen[0] == 0 -> seen[0] = 1 :: else -> seen[1] = 1 fi
       :: else -> skip
       fi }
  :: d_step { net[2] > 0 -> net[2]--;
       if
       :: BUGGY && last != 2 -> balance = balance + 10; last = 2
       :: !BUGGY && !SEEN(2) -> balance = balance + 10; if :: seen[0] == 0 -> seen[0] = 2 :: else -> seen[1] = 2 fi
       :: else -> skip
       fi }
  :: d_step { faults < FAULTS && net[1] > 0 -> net[1]++; faults++ }
  :: d_step { faults < FAULTS && net[2] > 0 -> net[2]++; faults++ }
  :: d_step { faults < FAULTS && net[1] > 0 -> net[1]--; faults++ }
  :: d_step { faults < FAULTS && net[2] > 0 -> net[2]--; faults++ }
  od
}

ltl p_creditedOnce { [] (balance <= 10 * sent) }
