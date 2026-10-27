machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var follower: machine;
      // Neither node restarts: the fault, if any, is a lost message.
      net = new Network(config.faults);
      follower = new Follower((net = net, buggy = config.buggy));
      new Leader((net = net, follower = follower));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert FollowerIsPrefix in { Buggy, Main, Network, Leader, Follower };
test tcFixed [main = Fixed]: assert FollowerIsPrefix in { Fixed, Main, Network, Leader, Follower };
test tcFixedOneFault [main = FixedOneFault]: assert FollowerIsPrefix in { FixedOneFault, Main, Network, Leader, Follower };
