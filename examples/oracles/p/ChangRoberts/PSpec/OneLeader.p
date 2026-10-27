// At most one node leads.
spec OneLeader observes eLeads {
  var leaders: set[int];
  start state Watching {
    on eLeads do (l: (who: int, leads: bool)) {
      if (l.leads) { leaders += (l.who); } else { leaders -= (l.who); }
      assert sizeof(leaders) <= 1, "two nodes lead";
    }
  }
}
