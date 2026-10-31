machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var wire: machine;
      var shop: machine;
      wire = new Wire(config.faults);
      shop = new Receiver(config.buggy);
      new Provider((wire = wire, shop = shop));
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine BuggyOneFault { start state S { entry { new Main((buggy = true, faults = 1)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
machine FixedTwoFaults { start state S { entry { new Main((buggy = false, faults = 2)); } } }
test tcBuggy [main = Buggy]: assert CreditedOnce in { Buggy, Main, Wire, Provider, Receiver };
test tcBuggyOneFault [main = BuggyOneFault]: assert CreditedOnce in { BuggyOneFault, Main, Wire, Provider, Receiver };
test tcFixedOneFault [main = FixedOneFault]: assert CreditedOnce in { FixedOneFault, Main, Wire, Provider, Receiver };
test tcFixedTwoFaults [main = FixedTwoFaults]: assert CreditedOnce in { FixedTwoFaults, Main, Wire, Provider, Receiver };
