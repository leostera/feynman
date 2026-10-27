// An independent model of examples/dining-philosophers.ts, in P: two philosophers and two
// forks, a fork queueing the requests it cannot grant. Buggy, Kant takes fork two first.
event eTake: machine;
event eGranted;
event eRelease;
event eEatNow;
event eFinishNow;
event ePhase: (who: int, phase: int);

machine Fork {
  var net: machine;
  var holder: machine;
  var held: bool;
  var queue: seq[machine];
  start state Lying {
    entry (n: machine) { net = n; }
    on eTake do (from: machine) {
      if (held) { queue += (sizeof(queue), from); return; }
      held = true;
      holder = from;
      Post(net, from, eGranted, null);
    }
    on eRelease do {
      if (sizeof(queue) == 0) { held = false; return; }
      holder = queue[0];
      queue -= (0);
      Post(net, holder, eGranted, null);
    }
  }
}

// Phases: 0 thinking, 1 waiting for the first fork, 2 for the second, 3 eating.
machine Philosopher {
  var net: machine;
  var who: int;
  var first: machine;
  var second: machine;
  var phase: int;
  start state Seated {
    entry (config: (net: machine, who: int, first: machine, second: machine)) {
      net = config.net; who = config.who; first = config.first; second = config.second;
    }
    on eEatNow do {
      if (phase != 0) { return; }
      Enter(1);
      Post(net, first, eTake, this);
    }
    on eFinishNow do {
      if (phase != 3) { return; }
      Enter(0);
      Post(net, first, eRelease, null);
      Post(net, second, eRelease, null);
    }
    on eGranted do {
      if (phase == 1) {
        Enter(2);
        Post(net, second, eTake, this);
      } else if (phase == 2) {
        Enter(3);
      }
    }
  }
  fun Enter(p: int) {
    phase = p;
    announce ePhase, (who = who, phase = p);
  }
}

// People: either philosopher gets hungry or finishes, at most twice each, at any moment.
machine People {
  var philosophers: seq[machine];
  var left: int;
  start state Acting {
    entry (ps: seq[machine]) { philosophers = ps; left = 8; send this, eStep; }
    on eStep do {
      var p: machine;
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        p = philosophers[choose(2)];
        if ($) { send p, eEatNow; } else { send p, eFinishNow; }
      }
      send this, eStep;
    }
  }
}
