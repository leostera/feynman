// No participant commits while another aborts.
spec Atomic observes eOutcome {
  var commits: int;
  var aborts: int;
  start state Watching {
    on eOutcome do (o: (who: machine, commit: bool)) {
      if (o.commit) { commits = commits + 1; } else { aborts = aborts + 1; }
      assert !(commits > 0 && aborts > 0), "one participant committed while another aborted";
    }
  }
}
