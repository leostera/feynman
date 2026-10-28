// An independent model of examples/log-replication.ts, in P. The leader appends x, then y,
// at any moment, sending each to the follower. Buggy, the follower appends whatever
// arrives; fixed, only the entry that goes right after its last, else it says how far its
// log reaches and the leader sends that entry.
type tEntry = (index: int, value: string);

event eAppend: (from: machine, index: int, value: string);
event eBehind: int;
event eLeaderAppended: string;
event eFollowerAppended: tEntry;

machine Leader {
  var net: machine;
  var follower: machine;
  var log: seq[string];
  start state Leading {
    entry (config: (net: machine, follower: machine)) { net = config.net; follower = config.follower; send this, eStep; }
    on eStep do {
      var next: string;
      if (sizeof(log) == 2) { return; }
      if ($) {
        if (sizeof(log) == 0) { next = "x"; } else { next = "y"; }
        log += (sizeof(log), next);
        announce eLeaderAppended, next;
        Post(net, follower, eAppend, (from = this, index = sizeof(log) - 1, value = next));
      }
      send this, eStep;
    }
    on eBehind do (length: int) {
      if (length < sizeof(log)) { Post(net, follower, eAppend, (from = this, index = length, value = log[length])); }
    }
  }
}

machine Follower {
  var net: machine;
  var buggy: bool;
  var log: seq[string];
  start state Following {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eAppend do (e: (from: machine, index: int, value: string)) {
      if (buggy || e.index == sizeof(log)) {
        announce eFollowerAppended, (index = sizeof(log), value = e.value);
        log += (sizeof(log), e.value);
        return;
      }
      Post(net, e.from, eBehind, sizeof(log));
    }
  }
}
