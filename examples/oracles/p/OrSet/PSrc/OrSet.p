// An independent model of examples/or-set.ts, in P: two replicas sharing a set that holds x
// or not, each adding twice and removing twice (while it has x), at any moment. Buggy applies
// adds and removes as they come; fixed is an OR-Set with tombstones. Everything is durable,
// so a restart changes nothing.
type tTag = (replica: int, n: int);

event eAdd: tTag;
event eRemove: set[tTag];
event eContains: (replica: int, has: bool);

machine Replica {
  var net: machine;
  var other: machine;
  var id: int;
  var buggy: bool;
  var has: bool;
  var tags: set[tTag];
  var removed: set[tTag];
  var adds: int;
  var removes: int;
  start state Serving {
    entry (config: (net: machine, id: int, buggy: bool)) { net = config.net; id = config.id; buggy = config.buggy; }
    on eSetOther do (o: machine) { other = o; send this, eStep; }
    on eStep do {
      var tag: tTag;
      var seen: set[tTag];
      if ($ && adds < 2) {
        adds = adds + 1;
        tag = (replica = id, n = adds);
        has = true;
        if (!buggy) { tags += (tag); }
        Announce();
        Post(net, other, eAdd, tag);
      } else if ($ && removes < 2 && Contains()) {
        removes = removes + 1;
        seen = tags;
        has = false;
        tags = default(set[tTag]);
        foreach (tag in seen) { removed += (tag); }
        Announce();
        Post(net, other, eRemove, seen);
      }
      // Until it stops, at a moment of its choosing: x may come back, and a remove with it.
      if ((adds < 2 || removes < 2) && $) { send this, eStep; }
    }
    on eAdd do (tag: tTag) {
      has = true;
      if (!buggy && !(tag in removed)) { tags += (tag); }
      Announce();
    }
    on eRemove do (seen: set[tTag]) {
      var tag: tTag;
      has = false;
      if (!buggy) {
        foreach (tag in seen) { tags -= (tag); removed += (tag); }
      }
      Announce();
    }
    on eRestart do { }
  }
  fun Contains(): bool { if (buggy) { return has; } return sizeof(tags) > 0; }
  fun Announce() { announce eContains, (replica = id, has = Contains()); }
}

event eSetOther: machine;
