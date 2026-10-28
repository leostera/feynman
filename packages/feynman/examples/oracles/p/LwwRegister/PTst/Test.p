machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var replicas: seq[machine];
      var victims: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      replicas += (0, new Replica((id = 0, buggy = config.buggy)));
      replicas += (1, new Replica((id = 1, buggy = config.buggy)));
      victims += (0, new Writer((net = net, replicas = replicas, id = 1)));
      victims += (1, new Writer((net = net, replicas = replicas, id = 2)));
      victims += (2, replicas[0]);
      victims += (3, replicas[1]);
      new Chaos((victims = victims, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert LWW in { Buggy, Main, Network, Chaos, Writer, Replica };
test tcFixed [main = Fixed]: assert LWW in { Fixed, Main, Network, Chaos, Writer, Replica };
test tcFixedOneFault [main = FixedOneFault]: assert LWW in { FixedOneFault, Main, Network, Chaos, Writer, Replica };
