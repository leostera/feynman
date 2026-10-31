/* An independent model of examples/outbox.ts, for SPIN. A client places orders; the shop
   stores each and queues its announcement in an outbox, which a guarded step publishes to a
   mailer. A fault loses a message, or restarts the shop, which keeps its orders and, fixed,
   its outbox. The network is a bag: a count of copies of each kind. The harness defines
   BUGGY, FAULTS and REPEATS. */
byte orders, outbox, announced, acts, faults;
byte placing, placed;   /* PlaceOrder and OrderPlaced in flight */

active proctype system() {
end:
  do
  :: d_step { acts < REPEATS -> acts++; placing++ }
  :: d_step { outbox > 0 -> outbox--; placed++ }
  :: d_step { placing > 0 -> placing--; orders++; outbox++ }
  :: d_step { placed > 0 -> placed--; announced++ }
  :: d_step { faults < FAULTS && placing > 0 -> placing--; faults++ }
  :: d_step { faults < FAULTS && placed > 0 -> placed--; faults++ }
  :: d_step { faults < FAULTS -> faults++; if :: BUGGY -> outbox = 0 :: else -> skip fi }
  od
}

ltl p_announcedOnceQuiet { [] (placing + placed > 0 || outbox > 0 || announced == orders) }
