// Once nothing is in flight, every replica holds the same write. The system always comes to
// rest, so a monitor that sees the replicas apart at the end has found the bug.
spec LWW observes eHeld {
  var held: map[int, tStamp];
  start cold state Agree {
    entry { if (!(0 in held)) { held[0] = (ts = 0, writer = 0); held[1] = (ts = 0, writer = 0); } }
    on eHeld do (h: (replica: int, stamp: tStamp)) {
      held[h.replica] = h.stamp;
      if (held[0] != held[1]) { goto Apart; }
    }
  }
  hot state Apart {
    on eHeld do (h: (replica: int, stamp: tStamp)) {
      held[h.replica] = h.stamp;
      if (held[0] == held[1]) { goto Agree; }
    }
  }
}
