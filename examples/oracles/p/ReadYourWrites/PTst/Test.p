machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var leader: machine;
      var follower: machine;
      var servers: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      follower = new Follower((net = net, buggy = config.buggy));
      leader = new Leader((net = net, follower = follower));
      new Client((net = net, leader = leader, follower = follower));
      servers += (0, leader);
      servers += (1, follower);
      new Chaos((victims = servers, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert ReadsOwnWrites in { Buggy, Main, Network, Chaos, Client, Leader, Follower };
test tcFixed [main = Fixed]: assert ReadsOwnWrites in { Fixed, Main, Network, Chaos, Client, Leader, Follower };
test tcFixedOneFault [main = FixedOneFault]: assert ReadsOwnWrites in { FixedOneFault, Main, Network, Chaos, Client, Leader, Follower };
