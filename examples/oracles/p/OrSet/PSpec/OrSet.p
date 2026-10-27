// Once nothing is in flight, the replicas agree on whether x is in the set. The system
// always comes to rest, so a monitor that sees them apart at the end has found the bug.
spec OrSet observes eContains {
  var has: map[int, bool];
  start cold state Agree {
    entry { if (!(0 in has)) { has[0] = false; has[1] = false; } }
    on eContains do (c: (replica: int, has: bool)) {
      has[c.replica] = c.has;
      if (has[0] != has[1]) { goto Apart; }
    }
  }
  hot state Apart {
    on eContains do (c: (replica: int, has: bool)) {
      has[c.replica] = c.has;
      if (has[0] == has[1]) { goto Agree; }
    }
  }
}
