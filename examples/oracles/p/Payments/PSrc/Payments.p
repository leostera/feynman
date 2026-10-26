// An independent model of specs/payments.ts, in P: one client paying, retrying on a timer.
event eDebit: (from: machine, id: int);
event eDebited: int;
event ePayNow;
event ePaid;
event eDebitMade;

machine Bank {
  var net: machine;
  var buggy: bool;
  var seen: set[int];
  start state Open {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eDebit do (d: (from: machine, id: int)) {
      if (buggy || !(d.id in seen)) {
        seen += (d.id);
        announce eDebitMade;
      }
      Post(net, d.from, eDebited, d.id);
    }
  }
}

machine Client {
  var net: machine;
  var bank: machine;
  var timer: machine;
  var pending: int;
  var fresh: int;
  var generation: int;
  start state Paying {
    entry (config: (net: machine, bank: machine)) { net = config.net; bank = config.bank; timer = new Timer(); }
    on ePayNow do {
      if (pending != 0) { return; }
      fresh = fresh + 1;
      pending = fresh;
      announce ePaid;
      Post(net, bank, eDebit, (from = this, id = pending));
      generation = generation + 1;
      send timer, eArm, (owner = this, generation = generation);
    }
    on eDebited do (id: int) {
      if (pending != id) { return; }
      pending = 0;
      generation = generation + 1;
    }
    on eFire do (g: int) {
      if (g != generation || pending == 0) { return; }
      Post(net, bank, eDebit, (from = this, id = pending));
      generation = generation + 1;
      send timer, eArm, (owner = this, generation = generation);
    }
  }
}

// People: pay, at most twice, at any moment.
machine People {
  start state Acting {
    entry (client: machine) {
      send client, ePayNow;
      send client, ePayNow;
    }
  }
}
