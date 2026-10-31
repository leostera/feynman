// An independent model of examples/webhooks.ts, in P: a provider sends two events; the shop
// credits each, skipping the last event it saw (buggy) or any event it saw before (fixed).
// The network is a bag that, within a fault budget, may deliver a message twice or lose it:
// the shared Network only loses, so this one is the project's own.
event eEvent: int;
event eNotified: int;
event eCredited: int;
event eWireSend: (dest: machine, id: int);
event eWireStep;

machine Wire {
  var bag: seq[(dest: machine, id: int)];
  var faults: int;
  start state Running {
    entry (budget: int) { faults = budget; }
    on eWireSend do (m: (dest: machine, id: int)) {
      bag += (sizeof(bag), m);
      if (sizeof(bag) == 1) { send this, eWireStep; }
    }
    on eWireStep do {
      var i: int;
      var m: (dest: machine, id: int);
      if (sizeof(bag) == 0) { return; }
      i = choose(sizeof(bag));
      m = bag[i];
      if (faults > 0 && $) {
        faults = faults - 1;
        // A fault: the message is duplicated (stays, with a second copy) or lost.
        if ($) { bag += (sizeof(bag), m); } else { bag -= (i); }
      } else {
        bag -= (i);
        send m.dest, eEvent, m.id;
      }
      if (sizeof(bag) > 0) { send this, eWireStep; }
    }
  }
}

machine Provider {
  start state Notifying {
    entry (config: (wire: machine, shop: machine)) {
      announce eNotified, 1;
      send config.wire, eWireSend, (dest = config.shop, id = 1);
      announce eNotified, 2;
      send config.wire, eWireSend, (dest = config.shop, id = 2);
    }
  }
}

machine Receiver {
  var buggy: bool;
  var last: int;
  var seen: set[int];
  start state Receiving {
    entry (b: bool) { buggy = b; }
    on eEvent do (id: int) {
      if (buggy) {
        if (last == id) { return; }
        last = id;
      } else {
        if (id in seen) { return; }
        seen += (id);
      }
      announce eCredited, id;
    }
  }
}
