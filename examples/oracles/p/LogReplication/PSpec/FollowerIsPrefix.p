// The follower's log is always the start of the leader's.
spec FollowerIsPrefix observes eLeaderAppended, eFollowerAppended {
  var leader: seq[string];
  start state Watching {
    on eLeaderAppended do (v: string) { leader += (sizeof(leader), v); }
    on eFollowerAppended do (e: tEntry) {
      assert e.index < sizeof(leader) && leader[e.index] == e.value, "the follower's log is not the start of the leader's";
    }
  }
}
