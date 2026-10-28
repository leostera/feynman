// Once nothing is in flight or queued, every stored order has been announced. The system
// always comes to rest, so a monitor still owed an announcement at the end is the bug.
spec Announced observes eStored, eAnnounced {
  var owed: int;
  start cold state Settled {
    on eStored do { owed = owed + 1; goto Owed; }
    on eAnnounced do { owed = owed - 1; }
  }
  hot state Owed {
    on eStored do { owed = owed + 1; }
    on eAnnounced do {
      owed = owed - 1;
      if (owed == 0) { goto Settled; }
    }
  }
}
