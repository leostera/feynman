/* An independent model of examples/cache.ts, for SPIN. An app reads through a cache and
   writes to a database, which invalidates the cache with the new version. On a miss the cache
   loads from the database; buggy, it fills with whatever comes back; fixed, not with a value
   older than an invalidation it has seen. Every actor is a singleton, so the only faults are
   lost messages. The network is a bag: a count of copies of each message. The harness
   defines BUGGY, FAULTS and REPEATS. Values are 1 (a), 2 (b) and 3 (c); an entry of value 0
   is empty. */
byte value = 1, version, entryValue, entryVersion, invalidated;
bool loading;
byte reads, writes, faults;
byte get, load;
byte loaded[9];       /* Loaded in flight, at (value - 1) * 3 + version */
byte update[4];       /* Update in flight, by value (2 and 3) */
byte invalidate[3];   /* Invalidate in flight, by version (1 and 2) */

inline onLoaded(v, n) {
  d_step { loaded[(v - 1) * 3 + n] > 0 -> loaded[(v - 1) * 3 + n]--; loading = 0;
    if :: !BUGGY && n < invalidated -> skip :: else -> entryValue = v; entryVersion = n fi }
}
inline onUpdate(v) { d_step { update[v] > 0 -> update[v]--; value = v; version++; assert(version <= 2); invalidate[version]++ } }
inline onInvalidate(n) { d_step { invalidate[n] > 0 -> invalidate[n]--; entryValue = 0; entryVersion = 0; if :: n > invalidated -> invalidated = n :: else -> skip fi } }
inline lost(c) { d_step { faults < FAULTS && c > 0 -> c--; faults++ } }
#define LOADED(v, n) :: onLoaded(v, n) :: lost(loaded[(v - 1) * 3 + n])

active proctype system() {
end:
  do
  :: d_step { reads < REPEATS -> reads++; get++ }
  :: d_step { writes < REPEATS -> writes++; update[2]++ }
  :: d_step { writes < REPEATS -> writes++; update[3]++ }
  :: d_step { get > 0 -> get--; if :: entryValue != 0 || loading -> skip :: else -> loading = 1; load++ fi }
  :: d_step { load > 0 -> load--; assert(version <= 2); loaded[(value - 1) * 3 + version]++ }
  LOADED(1, 0) LOADED(1, 1) LOADED(1, 2)
  LOADED(2, 0) LOADED(2, 1) LOADED(2, 2)
  LOADED(3, 0) LOADED(3, 1) LOADED(3, 2)
  :: onUpdate(2)
  :: onUpdate(3)
  :: onInvalidate(1)
  :: onInvalidate(2)
  :: lost(get)
  :: lost(load)
  :: lost(update[2])
  :: lost(update[3])
  :: lost(invalidate[1])
  :: lost(invalidate[2])
  od
}

#define QUIET (get + load + loaded[0] + loaded[1] + loaded[2] + loaded[3] + loaded[4] + loaded[5] + loaded[6] + loaded[7] + loaded[8] + update[2] + update[3] + invalidate[1] + invalidate[2] == 0)
ltl p_consistentOnceQuiet { [] (!QUIET || entryValue == 0 || entryValue == value) }
