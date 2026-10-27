// An independent model of examples/primary-backup.ts, in P. Buggy, the primary acknowledges
// a write as it stores it; fixed, once the backup confirms. The servers keep their writes
// through a restart (from the Chaos machine), so a restart changes nothing.
event eWrite: machine;
event eAck;
event eReplicate;
event eReplicated;
event eAcked;
event eBackedUp;

machine Client {
  var net: machine;
  var primary: machine;
  var left: int;
  start state Writing {
    entry (config: (net: machine, primary: machine)) { net = config.net; primary = config.primary; left = 2; send this, eStep; }
    // Writes at most twice, at any moment.
    on eStep do {
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        Post(net, primary, eWrite, this);
      }
      send this, eStep;
    }
    on eAck do { announce eAcked; }
  }
}

machine Primary {
  var net: machine;
  var client: machine;
  var backup: machine;
  var buggy: bool;
  var stored: int;
  start state Serving {
    entry (config: (net: machine, backup: machine, buggy: bool)) { net = config.net; backup = config.backup; buggy = config.buggy; }
    on eWrite do (from: machine) {
      client = from;
      stored = stored + 1;
      if (buggy) { Post(net, client, eAck, null); }
      Post(net, backup, eReplicate, this);
    }
    on eReplicated do { Post(net, client, eAck, null); }
    on eRestart do { }
  }
}

machine Backup {
  var net: machine;
  var buggy: bool;
  var stored: int;
  start state Serving {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eReplicate do (from: machine) {
      stored = stored + 1;
      announce eBackedUp;
      if (!buggy) { Post(net, from, eReplicated, null); }
    }
    on eRestart do { }
  }
}
