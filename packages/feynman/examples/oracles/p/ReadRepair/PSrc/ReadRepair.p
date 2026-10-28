// An independent model of examples/read-repair.ts, in P: a coordinator writes v1 and v2 to
// three replicas and reads once, at any moments, from the first two replies, repairing a
// replier that was behind. Replicas take a put only if newer; buggy, they take a repair as it
// comes. Replicas are wholly durable, so a restart changes nothing.
event ePut: int;
event eGet: machine;
event eGot: (from: machine, version: int);
event eRepair: int;
event eWentBack;

machine Coordinator {
  var net: machine;
  var replicas: seq[machine];
  var written: int;
  var reading: bool;
  var read: bool;
  var replies: map[machine, int];
  start state Coordinating {
    entry (config: (net: machine, replicas: seq[machine])) { net = config.net; replicas = config.replicas; send this, eStep; }
    on eStep do {
      var r: machine;
      if (written == 2 && read) { return; }
      if ($ && written < 2) {
        written = written + 1;
        foreach (r in replicas) { Post(net, r, ePut, written); }
      } else if ($ && !reading && !read) {
        reading = true;
        foreach (r in replicas) { Post(net, r, eGet, this); }
      }
      send this, eStep;
    }
    on eGot do (g: (from: machine, version: int)) {
      var newest: int;
      var r: machine;
      if (!reading) { return; }
      replies[g.from] = g.version;
      if (sizeof(replies) < 2) { return; }
      foreach (r in keys(replies)) { if (replies[r] > newest) { newest = replies[r]; } }
      foreach (r in keys(replies)) { if (replies[r] < newest) { Post(net, r, eRepair, newest); } }
      reading = false;
      read = true;
    }
  }
}

machine Replica {
  var net: machine;
  var buggy: bool;
  var version: int;
  var highest: int;
  start state Serving {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on ePut do (v: int) { if (v > version) { Hold(v); } }
    on eRepair do (v: int) { if (buggy || v > version) { Hold(v); } }
    on eGet do (from: machine) { Post(net, from, eGot, (from = this, version = version)); }
    on eRestart do { }
  }
  fun Hold(v: int) {
    version = v;
    if (version < highest) { announce eWentBack; }
    if (version > highest) { highest = version; }
  }
}
