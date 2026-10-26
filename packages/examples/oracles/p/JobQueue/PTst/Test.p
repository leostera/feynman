machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var worker: machine;
      var broker: machine;
      net = new Network(config.faults);
      worker = new Worker((net = net, buggy = config.buggy));
      broker = new Broker((net = net, worker = worker));
      send worker, eJoin, broker;
      new People(broker);
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert DoneOnce in { Buggy, Main, Network, Timer, Worker, Broker, People };
test tcFixed [main = Fixed]: assert DoneOnce in { Fixed, Main, Network, Timer, Worker, Broker, People };
test tcFixedOneFault [main = FixedOneFault]: assert DoneOnce in { FixedOneFault, Main, Network, Timer, Worker, Broker, People };
