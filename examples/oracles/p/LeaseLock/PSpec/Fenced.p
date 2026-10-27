// Storage never takes a write from an older lock holder after a newer one's.
spec Fenced observes eStored {
  var newest: int;
  start state Watching {
    on eStored do (t: int) {
      assert t >= newest, "storage took an older holder's write after a newer one's";
      newest = t;
    }
  }
}
