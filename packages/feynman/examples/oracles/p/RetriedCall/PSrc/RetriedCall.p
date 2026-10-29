// An independent model of examples/retried-call.ts, in P: a client pays through a call to the
// bank and, when the call fails, sends the same charge again. The bank charges every charge
// (buggy), or once per payment (fixed). The charge and its answer travel through the
// CallNetwork, which tells the client its call failed when it loses either.
event eCharge: (from: machine, payment: int);
event eCharged: int;
event eChargeFailed: int;
event eBankCharged: int;

machine Client {
  var net: machine;
  var bank: machine;
  start state Paying {
    entry (config: (net: machine, bank: machine)) {
      net = config.net; bank = config.bank;
      Charge(1);
    }
    on eCharged goto Paid;
    // The call threw: the same charge again.
    on eChargeFailed do (payment: int) { Charge(payment); }
  }
  state Paid {
    ignore eChargeFailed, eCharged;
  }
  fun Charge(payment: int) {
    Call(net, (dest = bank, ev = eCharge, payload = (from = this, payment = payment), caller = this, failure = eChargeFailed, failed = payment));
  }
}

machine Bank {
  var net: machine;
  var buggy: bool;
  var seen: set[int];
  start state Charging {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eCharge do (c: (from: machine, payment: int)) {
      if (buggy || !(c.payment in seen)) {
        announce eBankCharged, c.payment;
        if (!buggy) { seen += (c.payment); }
      }
      // The answer is part of the call: losing it fails the client's call too.
      Call(net, (dest = c.from, ev = eCharged, payload = c.payment, caller = c.from, failure = eChargeFailed, failed = c.payment));
    }
  }
}
