machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var one: machine;
      var two: machine;
      var ps: seq[machine];
      net = new Network(config.faults);
      one = new Fork(net);
      two = new Fork(net);
      ps += (0, new Philosopher((net = net, who = 0, first = one, second = two)));
      if (config.buggy) {
        ps += (1, new Philosopher((net = net, who = 1, first = two, second = one)));
      } else {
        ps += (1, new Philosopher((net = net, who = 1, first = one, second = two)));
      }
      new People(ps);
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert NoDeadlock in { Buggy, Main, Network, Fork, Philosopher, People };
test tcFixed [main = Fixed]: assert NoDeadlock in { Fixed, Main, Network, Fork, Philosopher, People };
test tcFixedOneFault [main = FixedOneFault]: assert NoDeadlock in { FixedOneFault, Main, Network, Fork, Philosopher, People };
