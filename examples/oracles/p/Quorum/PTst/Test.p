machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var replicas: seq[machine];
      var r: int;
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      replicas += (0, new Replica(net));
      replicas += (1, new Replica(net));
      replicas += (2, new Replica(net));
      if (config.buggy) { r = 1; } else { r = 2; }
      new Client((net = net, replicas = replicas, r = r));
      new Chaos((victims = replicas, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert ReadSeesWrite in { Buggy, Main, Network, Chaos, Client, Replica };
test tcFixed [main = Fixed]: assert ReadSeesWrite in { Fixed, Main, Network, Chaos, Client, Replica };
test tcFixedOneFault [main = FixedOneFault]: assert ReadSeesWrite in { FixedOneFault, Main, Network, Chaos, Client, Replica };
