// A network that keeps order, as Feynman's ordered messages are: of what is in flight to one
// machine, only the oldest may arrive next, and, within a fault budget, any may be lost, the
// rest keeping their order. The models that use it have each machine hear from one other,
// so what is in flight to a machine is one channel. Every message goes through here, and P
// delivers what it sends to each machine in order.
machine OrderedNetwork {
  var bag: seq[tEnvelope];
  var faults: int;

  start state Running {
    entry (budget: int) { faults = budget; }
    on eSend do (m: tEnvelope) {
      bag += (sizeof(bag), m);
      if (sizeof(bag) == 1) { send this, eStep; }
    }
    on eStep do {
      var i: int;
      var oldest: int;
      var m: tEnvelope;
      if (sizeof(bag) == 0) { return; }
      i = choose(sizeof(bag));
      if (faults > 0 && $) {
        faults = faults - 1;
        bag -= (i);
        announce eLost;
      } else {
        // The channel chosen is the chosen message's receiver's: its oldest message arrives.
        oldest = 0;
        while (bag[oldest].dest != bag[i].dest) { oldest = oldest + 1; }
        m = bag[oldest];
        bag -= (oldest);
        send m.dest, m.ev, m.payload;
      }
      if (sizeof(bag) > 0) { send this, eStep; }
    }
  }
}
