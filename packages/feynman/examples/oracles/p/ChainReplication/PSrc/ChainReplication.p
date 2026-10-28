// An independent model of examples/chain-replication.ts, in P: a head and a tail. Writes
// enter at the head, which passes them on. Buggy, the client reads from either replica;
// fixed, from the tail. One read at a time. Replicas keep their version through a restart.
event eWrite;
event eUpdate: int;
event eRead: machine;
event eValue: int;
event eReadBack: (version: int, seen: int);

machine Client {
  var net: machine;
  var head: machine;
  var tail: machine;
  var buggy: bool;
  var writes: int;
  var reads: int;
  var reading: bool;
  var seen: int;
  start state Working {
    entry (config: (net: machine, head: machine, tail: machine, buggy: bool)) {
      net = config.net; head = config.head; tail = config.tail; buggy = config.buggy;
      writes = 2; reads = 2;
      send this, eStep;
    }
    // Writes, and reads one at a time, at most twice each, at any moment.
    on eStep do {
      if (writes + reads == 0) { return; }
      if ($) {
        if ($) {
          if (writes > 0) { writes = writes - 1; Post(net, head, eWrite, null); }
        } else {
          if (reads > 0 && !reading) {
            reads = reads - 1;
            reading = true;
            if (buggy && $) { Post(net, head, eRead, this); } else { Post(net, tail, eRead, this); }
          }
        }
      }
      send this, eStep;
    }
    on eValue do (version: int) {
      reading = false;
      announce eReadBack, (version = version, seen = seen);
      if (version > seen) { seen = version; }
    }
  }
}

machine Head {
  var net: machine;
  var tail: machine;
  var version: int;
  start state Serving {
    entry (config: (net: machine, tail: machine)) { net = config.net; tail = config.tail; }
    on eWrite do {
      version = version + 1;
      Post(net, tail, eUpdate, version);
    }
    on eRead do (from: machine) { Post(net, from, eValue, version); }
    on eRestart do { }
  }
}

machine Tail {
  var net: machine;
  var version: int;
  start state Serving {
    entry (n: machine) { net = n; }
    on eUpdate do (v: int) { if (v > version) { version = v; } }
    on eRead do (from: machine) { Post(net, from, eValue, version); }
    on eRestart do { }
  }
}
