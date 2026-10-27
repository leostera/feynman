// At most one node holds the token.
spec OneToken observes eHolds {
  var holders: set[int];
  start state Watching {
    entry { holders += (0); }
    on eHolds do (h: (who: int, holds: bool)) {
      if (h.holds) { holders += (h.who); } else { holders -= (h.who); }
      assert sizeof(holders) <= 1, "two nodes hold the token";
    }
  }
}
