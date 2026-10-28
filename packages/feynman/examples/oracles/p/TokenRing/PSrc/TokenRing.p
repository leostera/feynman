// An independent model of examples/token-ring.ts, in P: three nodes in a ring, the token
// starting at node 0, resent on a timer until acknowledged. Everything is on disk, so a
// restart (from the Chaos machine) only stops the resend timer.
event eToken: (from: machine, count: int);
event eAck: int;
event ePassNow;
event eNext: machine;
event eHolds: (who: int, holds: bool);

machine Node {
  var net: machine;
  var next: machine;
  var timer: machine;
  var buggy: bool;
  var who: int;
  var holds: bool;
  var count: int;
  var unacked: int;
  var generation: int;
  start state Running {
    entry (config: (net: machine, buggy: bool, who: int)) {
      net = config.net; buggy = config.buggy; who = config.who; timer = new Timer();
      holds = who == 0;
    }
    on eNext do (n: machine) { next = n; }
    on ePassNow do {
      if (!holds) { return; }
      Hold(false);
      count = count + 1;
      unacked = count;
      SendToken();
    }
    on eToken do (t: (from: machine, count: int)) {
      if (buggy || t.count > count) {
        if (!holds) { Hold(true); }
        count = t.count;
      }
      Post(net, t.from, eAck, t.count);
    }
    on eAck do (c: int) {
      if (unacked != c) { return; }
      unacked = 0;
      generation = generation + 1;
    }
    on eFire do (g: int) {
      if (g != generation || unacked == 0) { return; }
      SendToken();
    }
    on eRestart do { generation = generation + 1; }
  }
  fun SendToken() {
    Post(net, next, eToken, (from = this, count = unacked));
    generation = generation + 1;
    send timer, eArm, (owner = this, generation = generation);
  }
  fun Hold(now: bool) {
    holds = now;
    announce eHolds, (who = who, holds = now);
  }
}

// People: whoever holds the token may pass it, at most twice each, at any moment.
machine People {
  var nodes: seq[machine];
  var left: int;
  start state Acting {
    entry (ns: seq[machine]) { nodes = ns; left = 6; send this, eStep; }
    on eStep do {
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        send nodes[choose(3)], ePassNow;
      }
      send this, eStep;
    }
  }
}
