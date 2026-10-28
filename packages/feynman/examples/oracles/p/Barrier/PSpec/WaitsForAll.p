// The barrier opens only once every worker has reached it.
spec WaitsForAll observes eReached, eOpened {
  var reached: set[machine];
  start state Watching {
    on eReached do (w: machine) { reached += (w); }
    on eOpened do { assert sizeof(reached) == 2, "the barrier opened before every worker reached it"; }
  }
}
