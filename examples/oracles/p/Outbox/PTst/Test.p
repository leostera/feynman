machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var mailer: machine;
      var shop: machine;
      var shops: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      mailer = new Mailer();
      shop = new Shop((net = net, mailer = mailer, buggy = config.buggy));
      shops += (0, shop);
      new Customer((net = net, shop = shop));
      new Chaos((victims = shops, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine BuggyOneFault { start state S { entry { new Main((buggy = true, faults = 1)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
test tcBuggy [main = Buggy]: assert Announced in { Buggy, Main, Network, Chaos, Mailer, Shop, Customer };
test tcBuggyOneFault [main = BuggyOneFault]: assert Announced in { BuggyOneFault, Main, Network, Chaos, Mailer, Shop, Customer };
test tcFixed [main = Fixed]: assert Announced in { Fixed, Main, Network, Chaos, Mailer, Shop, Customer };
test tcFixedOneFault [main = FixedOneFault]: assert Announced in { FixedOneFault, Main, Network, Chaos, Mailer, Shop, Customer };
