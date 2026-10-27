machine Main {
  start state Init {
    entry (config: (buggy: bool, faults: int)) {
      var net: machine;
      var server: machine;
      var storage: machine;
      var clients: seq[machine];
      net = new Network(config.faults);
      server = new LockServer(net);
      storage = new Storage(!config.buggy);
      clients += (0, new Client((net = net, server = server, storage = storage)));
      clients += (1, new Client((net = net, server = server, storage = storage)));
      new People(clients);
    }
  }
}
machine Buggy { start state S { entry { new Main((buggy = true, faults = 0)); } } }
machine Fixed { start state S { entry { new Main((buggy = false, faults = 0)); } } }
machine FixedOneFault { start state S { entry { new Main((buggy = false, faults = 1)); } } }
test tcBuggy [main = Buggy]: assert Fenced in { Buggy, Main, Network, Timer, LockServer, Storage, Client, People };
test tcFixed [main = Fixed]: assert Fenced in { Fixed, Main, Network, Timer, LockServer, Storage, Client, People };
test tcFixedOneFault [main = FixedOneFault]: assert Fenced in { FixedOneFault, Main, Network, Timer, LockServer, Storage, Client, People };
