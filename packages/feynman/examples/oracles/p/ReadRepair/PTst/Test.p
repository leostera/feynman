machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var replicas: seq[machine];
      var i: int;
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      while (i < 3) { replicas += (i, new Replica((net = net, buggy = config.buggy))); i = i + 1; }
      new Coordinator((net = net, replicas = replicas));
      new Chaos((victims = replicas, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert NeverGoesBack in { Buggy, Main, Network, Chaos, Coordinator, Replica };
test tcFixed [main = Fixed]: assert NeverGoesBack in { Fixed, Main, Network, Chaos, Coordinator, Replica };
test tcFixedOneFault [main = FixedOneFault]: assert NeverGoesBack in { FixedOneFault, Main, Network, Chaos, Coordinator, Replica };
