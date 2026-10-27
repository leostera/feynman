// A read never comes back older than the client's own writes it was told about.
spec ReadsOwnWrites observes eReadBack {
  start state Watching {
    on eReadBack do (v: tValue) { assert v.version >= v.atLeast, "a read came back older than the client's own write"; }
  }
}
