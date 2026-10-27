machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var roster: machine;
      var doctors: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      roster = new Roster(net);
      doctors += (0, new Doctor((net = net, roster = roster, buggy = config.buggy)));
      doctors += (1, new Doctor((net = net, roster = roster, buggy = config.buggy)));
      new People(doctors);
      new Chaos((victims = doctors, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert Covered in { Buggy, Main, Network, Chaos, Roster, Doctor, People };
test tcFixed [main = Fixed]: assert Covered in { Fixed, Main, Network, Chaos, Roster, Doctor, People };
test tcFixedOneFault [main = FixedOneFault]: assert Covered in { FixedOneFault, Main, Network, Chaos, Roster, Doctor, People };
