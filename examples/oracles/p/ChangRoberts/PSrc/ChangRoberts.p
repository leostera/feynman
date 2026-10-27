// An independent model of examples/chang-roberts.ts, in P: three nodes in a ring with ids
// 0 < 1 < 2. A restart (from the Chaos machine) forgets whether a node started and leads.
event eElection: int;
event eStartNow;
event eNext: machine;
event eLeads: (who: int, leads: bool);

machine Node {
  var net: machine;
  var next: machine;
  var buggy: bool;
  var who: int;
  var started: bool;
  var leader: bool;
  start state Running {
    entry (config: (net: machine, buggy: bool, who: int)) { net = config.net; buggy = config.buggy; who = config.who; }
    on eNext do (n: machine) { next = n; }
    on eStartNow do {
      if (started) { return; }
      started = true;
      Post(net, next, eElection, who);
    }
    on eElection do (id: int) {
      if (id > who) { Post(net, next, eElection, id); return; }
      if (id == who) { Lead(true); return; }
      if (buggy) { Lead(true); }
      if (started) { return; }
      started = true;
      Post(net, next, eElection, who);
    }
    on eRestart do {
      started = false;
      if (leader) { Lead(false); }
    }
  }
  fun Lead(now: bool) {
    if (leader == now) { return; }
    leader = now;
    announce eLeads, (who = who, leads = now);
  }
}

// People: any node may start an election, at most twice each, at any moment.
machine People {
  var nodes: seq[machine];
  var left: int;
  start state Acting {
    entry (ns: seq[machine]) { nodes = ns; left = 6; send this, eStep; }
    on eStep do {
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        send nodes[choose(3)], eStartNow;
      }
      send this, eStep;
    }
  }
}
