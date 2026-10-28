// An independent model of examples/barrier.ts, in P: two workers and a coordinator. Buggy,
// the coordinator counts arrivals; fixed, it keeps who arrived. A restart (from the Chaos
// machine) makes a worker forget it arrived.
event eArrived: machine;
event eGo;
event eArriveNow;
event eReached: machine;
event eOpened;

machine Coordinator {
  var net: machine;
  var buggy: bool;
  var workers: seq[machine];
  var count: int;
  var arrived: set[machine];
  var open: bool;
  start state Waiting {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eWorkers do (ws: seq[machine]) { workers = ws; }
    on eArrived do (from: machine) {
      var here: int;
      var i: int;
      if (open) { return; }
      if (buggy) { count = count + 1; here = count; } else { arrived += (from); here = sizeof(arrived); }
      if (here < sizeof(workers)) { return; }
      open = true;
      announce eOpened;
      while (i < sizeof(workers)) {
        Post(net, workers[i], eGo, null);
        i = i + 1;
      }
    }
  }
}

event eWorkers: seq[machine];

machine Worker {
  var net: machine;
  var coordinator: machine;
  var arrived: bool;
  start state Working {
    entry (config: (net: machine, coordinator: machine)) { net = config.net; coordinator = config.coordinator; }
    on eArriveNow do {
      if (arrived) { return; }
      arrived = true;
      announce eReached, this;
      Post(net, coordinator, eArrived, this);
    }
    on eGo do { }
    on eRestart do { arrived = false; }
  }
}

// People: either worker reaches the barrier, at most twice each, at any moment.
machine People {
  var workers: seq[machine];
  var left: int;
  start state Acting {
    entry (ws: seq[machine]) { workers = ws; left = 4; send this, eStep; }
    on eStep do {
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        send workers[choose(2)], eArriveNow;
      }
      send this, eStep;
    }
  }
}
