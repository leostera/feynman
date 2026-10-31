/* An independent model of examples/retried-call.ts, for SPIN. A client pays through a call
   to the bank and, when the call fails, sends the same charge again. The bank charges every
   charge (buggy), or once per payment (fixed). The network is a bag: a count of copies of
   the charge, its answer and the call's failure. A fault loses the charge or its answer, and
   either way the client is told its call failed; that failure is never lost. The harness
   defines BUGGY, FAULTS and REPEATS. */
bool paying, paid, seen;
byte charges, pays, faults;
byte charge, charged, failed;

active proctype system() {
end:
  do
  :: d_step { !paying && !paid && pays < REPEATS -> paying = 1; pays++; charge++ }
  /* The bank charges, unless (fixed) it has charged this payment, and answers. */
  :: d_step { charge > 0 -> charge--; if :: BUGGY || !seen -> charges++ :: else -> skip fi; if :: !BUGGY -> seen = 1 :: else -> skip fi; charged++ }
  :: d_step { charged > 0 -> charged--; paying = 0; paid = 1 }
  /* The call threw: the client sends the same charge again. */
  :: d_step { failed > 0 -> failed--; charge++ }
  :: d_step { faults < FAULTS && charge > 0 -> charge--; failed++; faults++ }
  :: d_step { faults < FAULTS && charged > 0 -> charged--; failed++; faults++ }
  od
}

ltl p_chargedOnce { [] (charges <= 1) }
