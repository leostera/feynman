// The network, as Feynman sees it: a bag of messages in flight, any of which may arrive next,
// and, within a fault budget, any of which may be lost. P delivers to each machine in order,
// so every message goes through here, which picks what arrives.
type tEnvelope = (dest: machine, ev: event, payload: any);

event eSend: tEnvelope;
event eStep;
event eLost;

machine Network {
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
      var m: tEnvelope;
      if (sizeof(bag) == 0) { return; }
      i = choose(sizeof(bag));
      m = bag[i];
      bag -= (i);
      if (faults > 0 && $) {
        faults = faults - 1;
        announce eLost;
      } else {
        send m.dest, m.ev, m.payload;
      }
      if (sizeof(bag) > 0) { send this, eStep; }
    }
  }
}

fun Post(net: machine, dest: machine, ev: event, payload: any) {
  send net, eSend, (dest = dest, ev = ev, payload = payload);
}
