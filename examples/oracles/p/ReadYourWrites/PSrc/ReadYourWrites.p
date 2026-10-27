// An independent model of examples/read-your-writes.ts, in P. Writes go to the leader,
// reads to the follower. Buggy, the follower answers with what it has; fixed, it holds a
// read until it has the write the read must see. A restart (from the Chaos machine) makes
// the follower forget the reads it held.
type tValue = (version: int, atLeast: int);

event eWrite: machine;
event eWritten: int;
event eReplicate: int;
event eRead: (from: machine, atLeast: int);
event eValue: tValue;
event eReadBack: tValue;

machine Client {
  var net: machine;
  var leader: machine;
  var follower: machine;
  var writes: int;
  var reads: int;
  var wrote: int;
  start state Working {
    entry (config: (net: machine, leader: machine, follower: machine)) {
      net = config.net; leader = config.leader; follower = config.follower;
      writes = 2; reads = 2;
      send this, eStep;
    }
    // Writes and reads, at most twice each, at any moment.
    on eStep do {
      if (writes + reads == 0) { return; }
      if ($) {
        if ($) {
          if (writes > 0) { writes = writes - 1; Post(net, leader, eWrite, this); }
        } else {
          if (reads > 0) { reads = reads - 1; Post(net, follower, eRead, (from = this, atLeast = wrote)); }
        }
      }
      send this, eStep;
    }
    on eWritten do (version: int) { if (version > wrote) { wrote = version; } }
    on eValue do (v: tValue) { announce eReadBack, v; }
  }
}

machine Leader {
  var net: machine;
  var follower: machine;
  var version: int;
  start state Leading {
    entry (config: (net: machine, follower: machine)) { net = config.net; follower = config.follower; }
    on eWrite do (from: machine) {
      version = version + 1;
      Post(net, from, eWritten, version);
      Post(net, follower, eReplicate, version);
    }
    on eRestart do { }
  }
}

machine Follower {
  var net: machine;
  var client: machine;
  var buggy: bool;
  var version: int;
  var holding: seq[int];
  start state Following {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eReplicate do (v: int) {
      var i: int;
      var kept: seq[int];
      if (v > version) { version = v; }
      i = 0;
      while (i < sizeof(holding)) {
        if (holding[i] <= version) { Post(net, client, eValue, (version = version, atLeast = holding[i])); }
        else { kept += (sizeof(kept), holding[i]); }
        i = i + 1;
      }
      holding = kept;
    }
    on eRead do (r: (from: machine, atLeast: int)) {
      client = r.from;
      if (!buggy && version < r.atLeast) {
        holding += (sizeof(holding), r.atLeast);
        return;
      }
      Post(net, r.from, eValue, (version = version, atLeast = r.atLeast));
    }
    on eRestart do { holding = default(seq[int]); }
  }
}
