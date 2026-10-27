// An independent model of examples/lease-lock.ts, in P: two clients, a lock server whose
// lease is a timer, and storage that fences (or not) on tokens. The lease and each client's
// stall are timers, which may fire at any moment once set.
event eAcquire: machine;
event eGranted: int;
event eDenied;
event eWrite: int;
event eAcquireNow;
event eStored: int;

machine LockServer {
  var net: machine;
  var timer: machine;
  var holder: machine;
  var leased: bool;
  var token: int;
  var generation: int;
  start state Serving {
    entry (n: machine) { net = n; timer = new Timer(); }
    on eAcquire do (asker: machine) {
      if (leased && holder != asker) {
        Post(net, asker, eDenied, null);
        return;
      }
      holder = asker;
      leased = true;
      token = token + 1;
      generation = generation + 1;
      send timer, eArm, (owner = this, generation = generation);
      Post(net, asker, eGranted, token);
    }
    on eFire do (g: int) {
      if (g != generation) { return; }
      leased = false;
    }
  }
}

machine Storage {
  var fenced: bool;
  var newest: int;
  start state Storing {
    entry (f: bool) { fenced = f; }
    on eWrite do (t: int) {
      if (fenced && t < newest) { return; }
      if (t > newest) { newest = t; }
      announce eStored, t;
    }
  }
}

machine Client {
  var net: machine;
  var server: machine;
  var storage: machine;
  var timer: machine;
  var held: int;
  var asking: bool;
  var generation: int;
  start state Working {
    entry (config: (net: machine, server: machine, storage: machine)) {
      net = config.net; server = config.server; storage = config.storage; timer = new Timer();
    }
    on eAcquireNow do {
      if (held != 0 || asking) { return; }
      asking = true;
      Post(net, server, eAcquire, this);
    }
    on eGranted do (t: int) {
      asking = false;
      held = t;
      generation = generation + 1;
      send timer, eArm, (owner = this, generation = generation);
    }
    on eDenied do { asking = false; }
    // The stall is over: write, believing the lock is still held.
    on eFire do (g: int) {
      if (g != generation || held == 0) { return; }
      Post(net, storage, eWrite, held);
      held = 0;
    }
  }
}

// People: take the lock on either client, at most twice each, at any moment.
machine People {
  var clients: seq[machine];
  var left: seq[int];
  start state Acting {
    entry (cs: seq[machine]) {
      clients = cs;
      left += (0, 2);
      left += (1, 2);
      send this, eStep;
    }
    on eStep do {
      var i: int;
      if (left[0] + left[1] == 0) { return; }
      if ($) {
        i = choose(2);
        if (left[i] > 0) {
          left[i] = left[i] - 1;
          send clients[i], eAcquireNow;
        }
      }
      send this, eStep;
    }
  }
}
