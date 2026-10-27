machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var account: machine;
      var tellers: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      account = new Account((net = net, buggy = config.buggy));
      tellers += (0, new Teller((net = net, account = account)));
      tellers += (1, new Teller((net = net, account = account)));
      new Chaos((victims = tellers, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert MoneyAddsUp in { Buggy, Main, Network, Chaos, Account, Teller };
test tcFixed [main = Fixed]: assert MoneyAddsUp in { Fixed, Main, Network, Chaos, Account, Teller };
test tcFixedOneFault [main = FixedOneFault]: assert MoneyAddsUp in { FixedOneFault, Main, Network, Chaos, Account, Teller };
