machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var bank: machine;
      var client: machine;
      net = new Network(config.faults);
      bank = new Bank((net = net, buggy = config.buggy));
      client = new Client((net = net, bank = bank));
      new People(client);
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert DebitedOnce in { Buggy, Main, Network, Timer, Bank, Client, People };
test tcFixed [main = Fixed]: assert DebitedOnce in { Fixed, Main, Network, Timer, Bank, Client, People };
test tcFixedOneFault [main = FixedOneFault]: assert DebitedOnce in { FixedOneFault, Main, Network, Timer, Bank, Client, People };
