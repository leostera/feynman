// A read that starts after a write has succeeded sees it.
spec ReadSeesWrite observes eReadDone {
  start state Watching {
    on eReadDone do (newest: int) { assert newest >= 1, "a read after a successful write missed it"; }
  }
}
