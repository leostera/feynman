machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var losses: int;
      var restarts: int;
      var net: machine;
      var nodes: seq[machine];
      // One budget, as the checker's: the fault, if any, is a lost message or a restart.
      if (config.faults > 0) {
        if ($) { losses = config.faults; } else { restarts = config.faults; }
      }
      net = new Network(losses);
      nodes += (0, new Node((net = net, buggy = config.buggy, who = 0)));
      nodes += (1, new Node((net = net, buggy = config.buggy, who = 1)));
      send nodes[0], ePeer, nodes[1];
      send nodes[1], ePeer, nodes[0];
      new People(nodes);
      new Chaos((victims = nodes, budget = restarts));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert Mutex in { Buggy, Main, Network, Chaos, Node, People };
test tcFixed [main = Fixed]: assert Mutex in { Fixed, Main, Network, Chaos, Node, People };
test tcFixedOneFault [main = FixedOneFault]: assert Mutex in { FixedOneFault, Main, Network, Chaos, Node, People };
