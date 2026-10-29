// The network, as Feynman sees calls (RFD0009): a bag of messages in flight, any of which may
// arrive next, and, within a fault budget, any of which may be lost. Every message here is a
// call or the answer to one, so losing it fails the call: the caller is told, directly, since
// the failure happens in its own process and cannot be lost in turn.
type tCall = (dest: machine, ev: event, payload: any, caller: machine, failure: event, failed: any);

event eSend: tCall;
event eStep;

machine CallNetwork {
  var bag: seq[tCall];
  var faults: int;

  start state Running {
    entry (budget: int) { faults = budget; }
    on eSend do (m: tCall) {
      bag += (sizeof(bag), m);
      if (sizeof(bag) == 1) { send this, eStep; }
    }
    on eStep do {
      var i: int;
      var m: tCall;
      if (sizeof(bag) == 0) { return; }
      i = choose(sizeof(bag));
      m = bag[i];
      bag -= (i);
      if (faults > 0 && $) {
        faults = faults - 1;
        send m.caller, m.failure, m.failed;
      } else {
        send m.dest, m.ev, m.payload;
      }
      if (sizeof(bag) > 0) { send this, eStep; }
    }
  }
}

fun Call(net: machine, m: tCall) {
  send net, eSend, m;
}
