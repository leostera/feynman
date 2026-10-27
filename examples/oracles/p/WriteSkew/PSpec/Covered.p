// Someone is always on call.
spec Covered observes eOnCall {
  start state Watching {
    on eOnCall do (n: int) { assert n >= 1, "nobody is on call"; }
  }
}
