// An independent model of examples/lww-register.ts, in P: two writers, two replicas. Each
// writer writes twice, at any moment, stamping each write with its own clock. A replica
// keeps the newest stamp; buggy, a tie keeps what it has, fixed, a tie goes to the later
// writer. A writer's restart (from the Chaos machine) resets its clock.
type tStamp = (ts: int, writer: int);

event ePut: tStamp;
event eHeld: (replica: int, stamp: tStamp);

machine Writer {
  var net: machine;
  var replicas: seq[machine];
  var id: int;
  var clock: int;
  var left: int;
  start state Writing {
    entry (config: (net: machine, replicas: seq[machine], id: int)) {
      net = config.net; replicas = config.replicas; id = config.id; left = 2;
      send this, eStep;
    }
    on eStep do {
      var i: int;
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        clock = clock + 1;
        i = 0;
        while (i < sizeof(replicas)) { Post(net, replicas[i], ePut, (ts = clock, writer = id)); i = i + 1; }
      }
      send this, eStep;
    }
    on eRestart do { clock = 0; }
  }
}

machine Replica {
  var id: int;
  var buggy: bool;
  var held: tStamp;
  start state Serving {
    entry (config: (id: int, buggy: bool)) { id = config.id; buggy = config.buggy; }
    on ePut do (p: tStamp) {
      if (p.ts > held.ts || (!buggy && p.ts == held.ts && p.writer > held.writer)) {
        held = p;
        announce eHeld, (replica = id, stamp = p);
      }
    }
    on eRestart do { }
  }
}
