machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var backup: machine;
      var primary: machine;
      var client: machine;
      var servers: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      backup = new Backup((net = net, buggy = config.buggy));
      primary = new Primary((net = net, backup = backup, buggy = config.buggy));
      client = new Client((net = net, primary = primary));
      servers += (0, primary);
      servers += (1, backup);
      new Chaos((victims = servers, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert AckedIsReplicated in { Buggy, Main, Network, Chaos, Client, Primary, Backup };
test tcFixed [main = Fixed]: assert AckedIsReplicated in { Fixed, Main, Network, Chaos, Client, Primary, Backup };
test tcFixedOneFault [main = FixedOneFault]: assert AckedIsReplicated in { FixedOneFault, Main, Network, Chaos, Client, Primary, Backup };
