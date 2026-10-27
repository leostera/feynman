// Never does each philosopher hold one fork while waiting for the other's.
spec NoDeadlock observes ePhase {
  var phases: map[int, int];
  start state Watching {
    entry { phases[0] = 0; phases[1] = 0; }
    on ePhase do (p: (who: int, phase: int)) {
      phases[p.who] = p.phase;
      assert !(phases[0] == 2 && phases[1] == 2), "each philosopher holds one fork and waits for the other";
    }
  }
}
