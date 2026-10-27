// An independent model of examples/ricart-agrawala.ts, in P: two nodes, 0 and 1 (0 wins
// ties). Fixed: ties go to the smaller id, the clock survives a restart (from the Chaos
// machine), and an answer counts only for the request it names.
event eRequest: (from: machine, who: int, ts: int);
event eOk: int;
event eAskNow;
event eExitNow;
event eInside: (who: int, inside: bool);
event ePeer: machine;

machine Node {
  var net: machine;
  var peer: machine;
  var buggy: bool;
  var who: int;
  var clock: int;
  var asking: int;
  var oks: int;
  var inside: bool;
  var deferred: seq[(asker: machine, ts: int)];
  start state Running {
    entry (config: (net: machine, buggy: bool, who: int)) { net = config.net; buggy = config.buggy; who = config.who; }
    on ePeer do (p: machine) { peer = p; }
    on eAskNow do {
      if (asking != 0 || inside) { return; }
      clock = clock + 1;
      asking = clock;
      oks = 0;
      Post(net, peer, eRequest, (from = this, who = who, ts = asking));
    }
    on eExitNow do {
      var i: int;
      if (!inside) { return; }
      Enter(false);
      asking = 0;
      while (i < sizeof(deferred)) {
        Post(net, deferred[i].asker, eOk, deferred[i].ts);
        i = i + 1;
      }
      deferred = default(seq[(asker: machine, ts: int)]);
    }
    on eRequest do (r: (from: machine, who: int, ts: int)) {
      var mineFirst: bool;
      if (r.ts > clock) { clock = r.ts; }
      mineFirst = asking != 0 && (asking < r.ts || (!buggy && asking == r.ts && who < r.who));
      if (inside || mineFirst) {
        deferred += (sizeof(deferred), (asker = r.from, ts = r.ts));
        return;
      }
      Post(net, r.from, eOk, r.ts);
    }
    on eOk do (ts: int) {
      if (asking == 0 || (!buggy && ts != asking)) { return; }
      oks = oks + 1;
      if (oks == 1 && !inside) { Enter(true); }
    }
    on eRestart do {
      if (buggy) { clock = 0; }
      asking = 0;
      oks = 0;
      if (inside) { Enter(false); }
      deferred = default(seq[(asker: machine, ts: int)]);
    }
  }
  fun Enter(now: bool) {
    inside = now;
    announce eInside, (who = who, inside = now);
  }
}

// People: either node asks or leaves, at most twice each, at any moment.
machine People {
  var nodes: seq[machine];
  var left: int;
  start state Acting {
    entry (ns: seq[machine]) { nodes = ns; left = 8; send this, eStep; }
    on eStep do {
      var n: machine;
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        n = nodes[choose(2)];
        if ($) { send n, eAskNow; } else { send n, eExitNow; }
      }
      send this, eStep;
    }
  }
}
