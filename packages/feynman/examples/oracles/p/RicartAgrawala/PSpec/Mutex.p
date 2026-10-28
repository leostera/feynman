// At most one node is in the critical section.
spec Mutex observes eInside {
  var inside: map[int, bool];
  start state Watching {
    entry { inside[0] = false; inside[1] = false; }
    on eInside do (e: (who: int, inside: bool)) {
      inside[e.who] = e.inside;
      assert !(inside[0] && inside[1]), "both nodes are in the critical section";
    }
  }
}
