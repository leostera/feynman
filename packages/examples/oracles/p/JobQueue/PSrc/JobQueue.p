// An independent model of specs/job-queue.ts, in P: a broker redelivering on a timer, and a
// worker working through its inbox.
event eJob: int;
event eAck: int;
event eWork;
event eEnqueueNow;
event eEnqueued;
event eEffect;

machine Worker {
  var net: machine;
  var broker: machine;
  var buggy: bool;
  var inbox: seq[int];
  var done: set[int];
  start state Working {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eJoin do (b: machine) { broker = b; }
    on eJob do (id: int) {
      inbox += (sizeof(inbox), id);
      send this, eWork;
    }
    on eWork do {
      var id: int;
      if (sizeof(inbox) == 0) { return; }
      id = inbox[0];
      inbox -= (0);
      if (buggy || !(id in done)) {
        done += (id);
        announce eEffect;
      }
      Post(net, broker, eAck, id);
    }
  }
}

event eJoin: machine;

machine Broker {
  var net: machine;
  var worker: machine;
  var timer: machine;
  var pending: int;
  var fresh: int;
  var generation: int;
  start state Running {
    entry (config: (net: machine, worker: machine)) { net = config.net; worker = config.worker; timer = new Timer(); }
    on eEnqueueNow do {
      if (pending != 0) { return; }
      fresh = fresh + 1;
      pending = fresh;
      announce eEnqueued;
      Post(net, worker, eJob, pending);
      generation = generation + 1;
      send timer, eArm, (owner = this, generation = generation);
    }
    on eAck do (id: int) {
      if (pending != id) { return; }
      pending = 0;
      generation = generation + 1;
    }
    on eFire do (g: int) {
      if (g != generation || pending == 0) { return; }
      Post(net, worker, eJob, pending);
      generation = generation + 1;
      send timer, eArm, (owner = this, generation = generation);
    }
  }
}

machine People {
  start state Acting {
    entry (broker: machine) {
      send broker, eEnqueueNow;
      send broker, eEnqueueNow;
    }
  }
}
