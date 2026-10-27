// An independent model of examples/lost-update.ts, in P: two tellers each withdraw 30 or 80,
// twice, at any moments, from an account of 100, by reading the balance and writing it back
// less the amount. Buggy, the account takes any write; fixed, only one naming its version,
// else the teller retries. A teller's restart (from the Chaos machine) forgets the withdrawal
// in progress.
event eGet: machine;
event eBalance: (balance: int, version: int);
event eSet: (from: machine, balance: int, version: int, amount: int);
event eOk;
event eConflict;
event eBooks: (balance: int, paidOut: int);

machine Account {
  var net: machine;
  var buggy: bool;
  var balance: int;
  var version: int;
  var paidOut: int;
  start state Open {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; balance = 100; }
    on eGet do (from: machine) { Post(net, from, eBalance, (balance = balance, version = version)); }
    on eSet do (s: (from: machine, balance: int, version: int, amount: int)) {
      if (!buggy && s.version != version) { Post(net, s.from, eConflict, null); return; }
      balance = s.balance;
      version = version + 1;
      paidOut = paidOut + s.amount;
      announce eBooks, (balance = balance, paidOut = paidOut);
      Post(net, s.from, eOk, null);
    }
  }
}

machine Teller {
  var net: machine;
  var account: machine;
  var status: string;
  var amount: int;
  var withdrawals: int;
  start state Working {
    entry (config: (net: machine, account: machine)) { net = config.net; account = config.account; status = "idle"; send this, eStep; }
    on eStep do {
      if (withdrawals == 2 && status == "idle") { return; }
      if (status == "idle" && withdrawals < 2 && $) {
        withdrawals = withdrawals + 1;
        if ($) { amount = 30; } else { amount = 80; }
        status = "reading";
        Post(net, account, eGet, this);
      } else if (status == "conflict" && $) {
        status = "reading";
        Post(net, account, eGet, this);
      }
      send this, eStep;
    }
    on eBalance do (b: (balance: int, version: int)) {
      if (status != "reading") { return; }
      if (b.balance < amount) { status = "idle"; return; }
      status = "writing";
      Post(net, account, eSet, (from = this, balance = b.balance - amount, version = b.version, amount = amount));
    }
    on eOk do { if (status == "writing") { status = "idle"; } }
    on eConflict do { if (status == "writing") { status = "conflict"; } }
    on eRestart do { status = "idle"; amount = 0; }
  }
}
