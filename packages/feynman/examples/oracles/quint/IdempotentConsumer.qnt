// An independent model of examples/idempotent-consumer.ts, in Quint, for Apalache. A broker
// hands one job to a consumer and hands it over again each time its timer fires, until the
// consumer says it is done. The consumer charges for a job it does not remember doing. A fault
// loses a message, or restarts the consumer, which keeps what it charged and, fixed, which jobs
// it has done. The broker does not restart. The network is a bag: a count of copies per kind.
// The harness sets BUGGY, FAULTS and REPEATS.
module IdempotentConsumer {
  const BUGGY: bool
  const FAULTS: int
  const REPEATS: int

  type Message = Job | Done

  var published: int
  var unacked: bool
  var timer: bool
  var processed: bool
  var charged: int
  var net: Message -> int
  var faults: int

  action init = all {
    published' = 0, unacked' = false, timer' = false, processed' = false, charged' = 0,
    net' = Set(Job, Done).mapBy(_ => 0), faults' = 0,
  }

  // One job: publishing is possible once (and at most REPEATS times).
  action publish = all {
    published < 1, published < REPEATS,
    published' = published + 1, unacked' = true, timer' = true, net' = net.setBy(Job, n => n + 1),
    processed' = processed, charged' = charged, faults' = faults,
  }
  action redeliver = all {
    timer,
    timer' = unacked, net' = if (unacked) net.setBy(Job, n => n + 1) else net,
    published' = published, unacked' = unacked, processed' = processed, charged' = charged, faults' = faults,
  }
  action onJob = all {
    net.get(Job) > 0,
    net' = net.setBy(Job, n => n - 1).setBy(Done, n => n + 1),
    processed' = true, charged' = if (processed) charged else charged + 1,
    published' = published, unacked' = unacked, timer' = timer, faults' = faults,
  }
  action onDone = all {
    net.get(Done) > 0,
    net' = net.setBy(Done, n => n - 1), unacked' = false, timer' = false,
    published' = published, processed' = processed, charged' = charged, faults' = faults,
  }
  action lose(m: Message): bool = all {
    faults < FAULTS, net.get(m) > 0, net' = net.setBy(m, n => n - 1), faults' = faults + 1,
    published' = published, unacked' = unacked, timer' = timer, processed' = processed, charged' = charged,
  }
  action restart = all {
    faults < FAULTS, faults' = faults + 1, processed' = if (BUGGY) false else processed,
    published' = published, unacked' = unacked, timer' = timer, charged' = charged, net' = net,
  }
  action nothing = all { published' = published, unacked' = unacked, timer' = timer, processed' = processed, charged' = charged, net' = net, faults' = faults }

  action step = any { publish, redeliver, onJob, onDone, lose(Job), lose(Done), restart, nothing }

  val chargedOnce = charged <= 1
}
