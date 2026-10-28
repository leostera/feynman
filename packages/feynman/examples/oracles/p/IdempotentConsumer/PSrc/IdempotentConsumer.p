// An independent model of examples/idempotent-consumer.ts, in P: a broker hands one job to a
// consumer and redelivers it on a timer until it hears back. The consumer charges for a job
// it does not remember processing; buggy, what it processed is lost on a restart (from the
// Chaos machine). The checker bounds redelivery by its depth; here a broker redelivers at most
// three times, which is plenty to reach the bug.
event eJob: (from: machine, job: int);
event eDone: int;
event eCharged: int;

machine Broker {
  var net: machine;
  var consumer: machine;
  var timer: machine;
  var generation: int;
  var unacked: set[int];
  var redeliveries: int;
  start state Brokering {
    entry (config: (net: machine, consumer: machine)) {
      net = config.net; consumer = config.consumer; timer = new Timer();
      unacked += (1);
      Post(net, consumer, eJob, (from = this, job = 1));
      Arm();
    }
    on eDone do (job: int) {
      unacked -= (job);
      if (sizeof(unacked) == 0) { generation = generation + 1; }
    }
    on eFire do (g: int) {
      if (g != generation || sizeof(unacked) == 0 || redeliveries == 3) { return; }
      redeliveries = redeliveries + 1;
      Post(net, consumer, eJob, (from = this, job = 1));
      Arm();
    }
  }
  fun Arm() { generation = generation + 1; send timer, eArm, (owner = this, generation = generation); }
}

machine Consumer {
  var net: machine;
  var buggy: bool;
  var processed: set[int];
  start state Consuming {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eJob do (j: (from: machine, job: int)) {
      if (!(j.job in processed)) {
        processed += (j.job);
        announce eCharged, j.job;
      }
      Post(net, j.from, eDone, j.job);
    }
    on eRestart do { if (buggy) { processed = default(set[int]); } }
  }
}
