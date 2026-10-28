// An independent model of examples/quorum.ts, in P, with three replicas. The client writes
// version 1 to all of them and is done at W = 2 acknowledgements; then reads from all of
// them and takes the newest of the first R answers: 1 buggy, 2 fixed. Replicas keep their
// version through a restart (from the Chaos machine).
event eWrite: (from: machine, version: int);
event eAck;
event eRead: machine;
event eValue: int;
event eReadDone: int;

machine Client {
  var net: machine;
  var replicas: seq[machine];
  var r: int;
  var phase: int; // 0 idle, 1 writing, 2 written, 3 reading, 4 read
  var acks: int;
  var answers: int;
  var newest: int;
  start state Working {
    entry (config: (net: machine, replicas: seq[machine], r: int)) {
      net = config.net; replicas = config.replicas; r = config.r;
      send this, eStep;
    }
    // Writes once, then, once the write has succeeded, reads once: each at any moment.
    on eStep do {
      var i: int;
      if (phase != 0 && phase != 2) { return; }
      if ($) {
        i = 0;
        while (i < sizeof(replicas)) {
          if (phase == 0) { Post(net, replicas[i], eWrite, (from = this, version = 1)); }
          else { Post(net, replicas[i], eRead, this); }
          i = i + 1;
        }
        phase = phase + 1;
      }
      send this, eStep;
    }
    on eAck do {
      if (phase != 1) { return; }
      acks = acks + 1;
      if (acks == 2) { phase = 2; send this, eStep; }
    }
    on eValue do (version: int) {
      if (phase != 3) { return; }
      answers = answers + 1;
      if (version > newest) { newest = version; }
      if (answers == r) { phase = 4; announce eReadDone, newest; }
    }
  }
}

machine Replica {
  var net: machine;
  var version: int;
  start state Serving {
    entry (n: machine) { net = n; }
    on eWrite do (w: (from: machine, version: int)) {
      if (w.version > version) { version = w.version; }
      Post(net, w.from, eAck, null);
    }
    on eRead do (from: machine) { Post(net, from, eValue, version); }
    on eRestart do { }
  }
}
