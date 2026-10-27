machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var a: machine;
      var b: machine;
      var victims: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      a = new Replica((net = net, id = 0, buggy = config.buggy));
      b = new Replica((net = net, id = 1, buggy = config.buggy));
      send a, eSetOther, b;
      send b, eSetOther, a;
      victims += (0, a);
      victims += (1, b);
      new Chaos((victims = victims, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert GCounter in { Buggy, Main, Network, Chaos, Replica };
test tcFixed [main = Fixed]: assert GCounter in { Fixed, Main, Network, Chaos, Replica };
test tcFixedOneFault [main = FixedOneFault]: assert GCounter in { FixedOneFault, Main, Network, Chaos, Replica };
