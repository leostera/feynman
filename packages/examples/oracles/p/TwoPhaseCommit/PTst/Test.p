machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var coordinator: machine;
      var a: machine;
      var b: machine;
      var ps: seq[machine];
      net = new Network(config.faults);
      coordinator = new Coordinator((net = net, buggy = config.buggy));
      a = new Participant((net = net, coordinator = coordinator));
      b = new Participant((net = net, coordinator = coordinator));
      ps += (0, a);
      ps += (1, b);
      send coordinator, eJoin, ps;
      new People((coordinator = coordinator, participants = ps));
    }
  }
}

machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }

test tcBuggy [main = Buggy]: assert Atomic in { Buggy, Main, Network, Coordinator, Participant, People };
test tcFixed [main = Fixed]: assert Atomic in { Fixed, Main, Network, Coordinator, Participant, People };
test tcFixedOneFault [main = FixedOneFault]: assert Atomic in { FixedOneFault, Main, Network, Coordinator, Participant, People };
