machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var nodes: seq[machine];
      var i: int;
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      while (i < 3) {
        nodes += (i, new Node((net = net, buggy = config.buggy, who = i)));
        i = i + 1;
      }
      i = 0;
      while (i < 3) {
        send nodes[i], eNext, nodes[(i + 1) % 3];
        i = i + 1;
      }
      new People(nodes);
      new Chaos((victims = nodes, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert OneLeader in { Buggy, Main, Network, Chaos, Node, People };
test tcFixed [main = Fixed]: assert OneLeader in { Fixed, Main, Network, Chaos, Node, People };
test tcFixedOneFault [main = FixedOneFault]: assert OneLeader in { FixedOneFault, Main, Network, Chaos, Node, People };
