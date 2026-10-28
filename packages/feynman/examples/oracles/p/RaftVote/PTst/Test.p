machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var nodes: seq[machine];
      var i: int;
      net = new Network(0);
      while (i < 3) {
        nodes += (i, new Node((net = net, buggy = config.buggy)));
        i = i + 1;
      }
      i = 0;
      while (i < 3) {
        send nodes[i], ePeers, nodes;
        i = i + 1;
      }
      new People(nodes);
      new Chaos((victims = nodes, budget = config.faults));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine BuggyOneFault { start state S { entry { new Main((buggy = true, faults = 1)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert OneLeader in { Buggy, Main, Network, Chaos, Node, People };
test tcBuggyOneFault [main = BuggyOneFault]: assert OneLeader in { BuggyOneFault, Main, Network, Chaos, Node, People };
test tcFixedOneFault [main = FixedOneFault]: assert OneLeader in { FixedOneFault, Main, Network, Chaos, Node, People };
