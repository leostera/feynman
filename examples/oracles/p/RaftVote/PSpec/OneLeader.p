// At most one node leads the term.
spec OneLeader observes eLeads, eDeposed {
  var leaders: set[machine];
  start state Watching {
    on eLeads do (n: machine) {
      leaders += (n);
      assert sizeof(leaders) <= 1, "two nodes lead the same term";
    }
    on eDeposed do (n: machine) { leaders -= (n); }
  }
}
