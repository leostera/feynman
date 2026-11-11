// The alternating bit protocol of ../AlternatingBit with one alternating bit (its buggy
// tags), on a network that reorders (buggy) or on one that keeps order (fixed).
machine Main {
  start state Init {
    entry (config: (ordered: bool, faults: int)) {
      var net: machine;
      var receiver: machine;
      var sender: machine;
      if (config.ordered) { net = new OrderedNetwork(config.faults); } else { net = new Network(config.faults); }
      receiver = new Receiver((net = net, buggy = true));
      sender = new Sender((net = net, receiver = receiver, buggy = true));
      send receiver, eSenderIs, sender;
      send sender, eStart;
    }
  }
}
machine Buggy { start state S { entry { new Main((ordered = false, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((ordered = true, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((ordered = true, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert InOrder in { Buggy, Main, Network, OrderedNetwork, Timer, Sender, Receiver };
test tcFixed [main = Fixed]: assert InOrder in { Fixed, Main, Network, OrderedNetwork, Timer, Sender, Receiver };
test tcFixedOneFault [main = FixedOneFault]: assert InOrder in { FixedOneFault, Main, Network, OrderedNetwork, Timer, Sender, Receiver };
