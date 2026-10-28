// An independent model of examples/g-counter.ts, in P: two replicas, each incrementing
// twice at any moment and sending its state to the other. Buggy, the state is a total,
// merged by the larger; fixed, a count per replica, merged pointwise, valued by the sum.
// Everything is durable, so a restart changes nothing.
event eState: (total: int, counts: map[int, int]);
event eIncremented;
event eValue: (replica: int, value: int);

fun Sum(counts: map[int, int]): int {
  var total: int;
  var k: int;
  foreach (k in keys(counts)) { total = total + counts[k]; }
  return total;
}

machine Replica {
  var net: machine;
  var other: machine;
  var id: int;
  var buggy: bool;
  var total: int;
  var counts: map[int, int];
  var left: int;
  start state Counting {
    entry (config: (net: machine, id: int, buggy: bool)) {
      net = config.net; id = config.id; buggy = config.buggy; left = 2;
      counts[0] = 0; counts[1] = 0;
    }
    on eSetOther do (o: machine) { other = o; send this, eStep; }
    on eStep do {
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        if (buggy) { total = total + 1; } else { counts[id] = counts[id] + 1; }
        announce eIncremented;
        Announce();
        Post(net, other, eState, (total = total, counts = counts));
      }
      send this, eStep;
    }
    on eState do (s: (total: int, counts: map[int, int])) {
      var k: int;
      if (buggy) {
        if (s.total > total) { total = s.total; }
      } else {
        foreach (k in keys(s.counts)) { if (s.counts[k] > counts[k]) { counts[k] = s.counts[k]; } }
      }
      Announce();
    }
    on eRestart do { }
  }
  fun Announce() {
    if (buggy) { announce eValue, (replica = id, value = total); }
    else { announce eValue, (replica = id, value = Sum(counts)); }
  }
}

event eSetOther: machine;
