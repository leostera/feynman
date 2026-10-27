// An independent model of examples/write-skew.ts, in P: two doctors and a roster. Buggy, a
// doctor checks the count and leaves in two messages; fixed, the roster checks and removes
// in one. A restart (from the Chaos machine) puts a doctor back on call in their own mind.
event eCheck: machine;
event eCount: int;
event eLeave;
event eLeaveIfCovered: machine;
event eLeft;
event eStay;
event eGoOffNow;
event eOnCall: int;

machine Roster {
  var net: machine;
  var onCall: int;
  start state Open {
    entry (n: machine) { net = n; onCall = 2; }
    on eCheck do (from: machine) { Post(net, from, eCount, onCall); }
    on eLeave do {
      onCall = onCall - 1;
      announce eOnCall, onCall;
    }
    on eLeaveIfCovered do (from: machine) {
      if (onCall < 2) {
        Post(net, from, eStay, null);
        return;
      }
      onCall = onCall - 1;
      announce eOnCall, onCall;
      Post(net, from, eLeft, null);
    }
  }
}

machine Doctor {
  var net: machine;
  var roster: machine;
  var buggy: bool;
  var phase: int; // 0 on call, 1 asking, 2 off
  start state Working {
    entry (config: (net: machine, roster: machine, buggy: bool)) { net = config.net; roster = config.roster; buggy = config.buggy; }
    on eGoOffNow do {
      if (phase != 0) { return; }
      phase = 1;
      if (buggy) { Post(net, roster, eCheck, this); } else { Post(net, roster, eLeaveIfCovered, this); }
    }
    on eCount do (n: int) {
      if (n < 2) { phase = 0; return; }
      phase = 2;
      Post(net, roster, eLeave, null);
    }
    on eLeft do { phase = 2; }
    on eStay do { phase = 0; }
    on eRestart do { phase = 0; }
  }
}

// People: either doctor asks to go off call, at most twice each, at any moment.
machine People {
  var doctors: seq[machine];
  var left: seq[int];
  start state Acting {
    entry (ds: seq[machine]) { doctors = ds; left += (0, 2); left += (1, 2); send this, eStep; }
    on eStep do {
      var i: int;
      if (left[0] + left[1] == 0) { return; }
      if ($) {
        i = choose(2);
        if (left[i] > 0) {
          left[i] = left[i] - 1;
          send doctors[i], eGoOffNow;
        }
      }
      send this, eStep;
    }
  }
}
