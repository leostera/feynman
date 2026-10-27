// A read never comes back older than one the client already read.
spec MonotonicReads observes eReadBack {
  start state Watching {
    on eReadBack do (r: (version: int, seen: int)) { assert r.version >= r.seen, "a read came back older than one already read"; }
  }
}
