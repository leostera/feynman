machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var bank: machine;
      net = new CallNetwork(config.faults);
      bank = new Bank((net = net, buggy = config.buggy));
      new Client((net = net, bank = bank));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine BuggyOneFault { start state S { entry { new Main((buggy = true, faults = 1)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
machine FixedTwoFaults { start state S { entry { new Main((buggy = false, faults = 2)); } } }
test tcBuggy [main = Buggy]: assert ChargedOnce in { Buggy, Main, CallNetwork, Bank, Client };
test tcBuggyOneFault [main = BuggyOneFault]: assert ChargedOnce in { BuggyOneFault, Main, CallNetwork, Bank, Client };
test tcFixedOneFault [main = FixedOneFault]: assert ChargedOnce in { FixedOneFault, Main, CallNetwork, Bank, Client };
test tcFixedTwoFaults [main = FixedTwoFaults]: assert ChargedOnce in { FixedTwoFaults, Main, CallNetwork, Bank, Client };
