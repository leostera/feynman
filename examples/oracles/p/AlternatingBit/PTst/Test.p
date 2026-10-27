machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var receiver: machine;
      var sender: machine;
      net = new Network(config.faults);
      receiver = new Receiver((net = net, buggy = config.buggy));
      sender = new Sender((net = net, receiver = receiver, buggy = config.buggy));
      send receiver, eSenderIs, sender;
      send sender, eStart;
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert InOrder in { Buggy, Main, Network, Timer, Sender, Receiver };
test tcFixed [main = Fixed]: assert InOrder in { Fixed, Main, Network, Timer, Sender, Receiver };
test tcFixedOneFault [main = FixedOneFault]: assert InOrder in { FixedOneFault, Main, Network, Timer, Sender, Receiver };
