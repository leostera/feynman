// An independent model of examples/alternating-bit.ts, in P. Every message goes through the
// Network machine, a bag that delivers in any order; buggy tags items with one alternating
// bit, fixed with their position. The retry timer may fire at any moment once set.
event eData: (tag: int, value: int);
event eAck: int;
event eStart;
event eKept: (position: int, value: int);

fun TagOf(buggy: bool, position: int): int {
  if (buggy) { return position % 2; }
  return position;
}

machine Receiver {
  var net: machine;
  var sender: machine;
  var buggy: bool;
  var kept: int;
  start state Receiving {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eData do (d: (tag: int, value: int)) {
      if (d.tag == TagOf(buggy, kept)) {
        announce eKept, (position = kept, value = d.value);
        kept = kept + 1;
      }
      Post(net, sender, eAck, d.tag);
    }
    on eSenderIs do (s: machine) { sender = s; }
  }
}

event eSenderIs: machine;

// Items are 0 ("x") and 1 ("y").
machine Sender {
  var net: machine;
  var receiver: machine;
  var timer: machine;
  var buggy: bool;
  var next: int;
  var started: bool;
  var generation: int;
  start state Sending {
    entry (config: (net: machine, receiver: machine, buggy: bool)) {
      net = config.net; receiver = config.receiver; buggy = config.buggy; timer = new Timer();
    }
    on eStart do {
      if (started) { return; }
      started = true;
      SendCurrent();
    }
    on eAck do (tag: int) {
      if (next >= 2 || tag != TagOf(buggy, next)) { return; }
      next = next + 1;
      generation = generation + 1;
      if (next < 2) { SendCurrent(); }
    }
    on eFire do (g: int) {
      if (g != generation || next >= 2) { return; }
      SendCurrent();
    }
  }
  fun SendCurrent() {
    Post(net, receiver, eData, (tag = TagOf(buggy, next), value = next));
    generation = generation + 1;
    send timer, eArm, (owner = this, generation = generation);
  }
}
