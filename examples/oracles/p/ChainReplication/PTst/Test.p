machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var head: machine;
      var tail: machine;
      var servers: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      tail = new Tail(net);
      head = new Head((net = net, tail = tail));
      new Client((net = net, head = head, tail = tail, buggy = config.buggy));
      servers += (0, head);
      servers += (1, tail);
      new Chaos((victims = servers, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert MonotonicReads in { Buggy, Main, Network, Chaos, Client, Head, Tail };
test tcFixed [main = Fixed]: assert MonotonicReads in { Fixed, Main, Network, Chaos, Client, Head, Tail };
test tcFixedOneFault [main = FixedOneFault]: assert MonotonicReads in { FixedOneFault, Main, Network, Chaos, Client, Head, Tail };
