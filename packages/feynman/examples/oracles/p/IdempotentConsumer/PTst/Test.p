machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var consumer: machine;
      var victims: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      consumer = new Consumer((net = net, buggy = config.buggy));
      victims += (0, consumer);
      new Broker((net = net, consumer = consumer));
      new Chaos((victims = victims, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine BuggyOneFault { start state S { entry { new Main((buggy = true, faults = 1)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert ChargedOnce in { Buggy, Main, Network, Chaos, Timer, Broker, Consumer };
test tcBuggyOneFault [main = BuggyOneFault]: assert ChargedOnce in { BuggyOneFault, Main, Network, Chaos, Timer, Broker, Consumer };
test tcFixedOneFault [main = FixedOneFault]: assert ChargedOnce in { FixedOneFault, Main, Network, Chaos, Timer, Broker, Consumer };
