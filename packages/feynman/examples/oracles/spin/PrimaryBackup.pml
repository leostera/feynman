/* An independent model of examples/primary-backup.ts, for SPIN. A client writes to a primary,
   which stores the write and replicates it to a backup; the client is acknowledged as the
   primary stores (buggy) or once the backup confirms (fixed). A fault loses a message, or
   restarts a server, which keeps what it stored: a restart only spends the budget. The
   network is a bag: a count of copies of each kind. The harness defines BUGGY, FAULTS and
   REPEATS. */
#define WRITE 0
#define REPLICATE 1
#define REPLICATED 2
#define ACK 3
byte acked, primary, backup, acts, faults;
byte net[4];

active proctype system() {
end:
  do
  :: d_step { acts < REPEATS -> acts++; net[WRITE]++ }
  :: d_step { net[WRITE] > 0 -> net[WRITE]--; primary++; net[REPLICATE]++; if :: BUGGY -> net[ACK]++ :: else -> skip fi }
  :: d_step { net[REPLICATE] > 0 -> net[REPLICATE]--; backup++; if :: !BUGGY -> net[REPLICATED]++ :: else -> skip fi }
  :: d_step { net[REPLICATED] > 0 -> net[REPLICATED]--; net[ACK]++ }
  :: d_step { net[ACK] > 0 -> net[ACK]--; acked++ }
  :: d_step { faults < FAULTS && net[WRITE] > 0 -> net[WRITE]--; faults++ }
  :: d_step { faults < FAULTS && net[REPLICATE] > 0 -> net[REPLICATE]--; faults++ }
  :: d_step { faults < FAULTS && net[REPLICATED] > 0 -> net[REPLICATED]--; faults++ }
  :: d_step { faults < FAULTS && net[ACK] > 0 -> net[ACK]--; faults++ }
  /* Either server restarting changes nothing but the budget. */
  :: d_step { faults < FAULTS -> faults++ }
  od
}

ltl p_ackedIsReplicated { [] (acked <= backup) }
