machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var coordinator: machine;
      var workers: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      coordinator = new Coordinator((net = net, buggy = config.buggy));
      workers += (0, new Worker((net = net, coordinator = coordinator)));
      workers += (1, new Worker((net = net, coordinator = coordinator)));
      send coordinator, eWorkers, workers;
      new People(workers);
      new Chaos((victims = workers, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine BuggyOneFault { start state S { entry { new Main((buggy = true, faults = 1)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert WaitsForAll in { Buggy, Main, Network, Chaos, Coordinator, Worker, People };
test tcBuggyOneFault [main = BuggyOneFault]: assert WaitsForAll in { BuggyOneFault, Main, Network, Chaos, Coordinator, Worker, People };
test tcFixedOneFault [main = FixedOneFault]: assert WaitsForAll in { FixedOneFault, Main, Network, Chaos, Coordinator, Worker, People };
