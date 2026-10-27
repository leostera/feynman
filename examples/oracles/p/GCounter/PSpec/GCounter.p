// Once nothing is in flight, every replica counts every increment. The system always comes
// to rest, so a monitor that sees a replica short at the end has found the bug.
spec GCounter observes eIncremented, eValue {
  var increments: int;
  var seen: map[int, int];
  start cold state Counted {
    entry { if (!(0 in seen)) { seen[0] = 0; seen[1] = 0; } }
    on eIncremented do { increments = increments + 1; goto Missing; }
    on eValue do (v: (replica: int, value: int)) { seen[v.replica] = v.value; }
  }
  hot state Missing {
    on eIncremented do { increments = increments + 1; }
    on eValue do (v: (replica: int, value: int)) {
      seen[v.replica] = v.value;
      if (seen[0] == increments && seen[1] == increments) { goto Counted; }
    }
  }
}
