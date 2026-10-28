// An independent model of examples/outbox.ts, in P. The shop's outbox drains by itself
// (a self-sent ePublish while it has something in it); a restart (from the Chaos machine)
// empties it unless it is durable.
event ePlaceOrder;
event eOrderPlaced;
event ePublish;
event eOrderNow;
event eStored;
event eAnnounced;

machine Mailer {
  start state Mailing {
    on eOrderPlaced do { announce eAnnounced; }
  }
}

machine Shop {
  var net: machine;
  var mailer: machine;
  var buggy: bool;
  var outbox: int;
  start state Open {
    entry (config: (net: machine, mailer: machine, buggy: bool)) { net = config.net; mailer = config.mailer; buggy = config.buggy; }
    on ePlaceOrder do {
      announce eStored;
      outbox = outbox + 1;
      send this, ePublish;
    }
    on ePublish do {
      if (outbox == 0) { return; }
      outbox = outbox - 1;
      Post(net, mailer, eOrderPlaced, null);
      if (outbox > 0) { send this, ePublish; }
    }
    on eRestart do {
      if (buggy) { outbox = 0; }
      if (outbox > 0) { send this, ePublish; }
    }
  }
}

// The customer: orders at most twice, at any moment.
machine Customer {
  var net: machine;
  var shop: machine;
  var left: int;
  start state Ordering {
    entry (config: (net: machine, shop: machine)) { net = config.net; shop = config.shop; left = 2; send this, eStep; }
    on eStep do {
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        Post(net, shop, ePlaceOrder, null);
      }
      send this, eStep;
    }
  }
}
