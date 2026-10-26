// An independent model of specs/two-phase-commit.ts, in P. People's choices (begin, how each
// participant votes) are nondeterministic; every message goes through the Network.
event ePrepare;
event eVote: (from: machine, yes: bool);
event eDecide: bool;
event eBegin;
event eVoteNow: bool;
event eOutcome: (who: machine, commit: bool);

machine Participant {
  var net: machine;
  var coordinator: machine;
  var prepared: bool;
  var voted: bool;
  var decided: bool;

  start state Waiting {
    entry (config: (net: machine, coordinator: machine)) { net = config.net; coordinator = config.coordinator; }
    on ePrepare do { prepared = true; }
    on eVoteNow do (yes: bool) {
      if (!prepared || voted) { return; }
      voted = true;
      if (!yes) { decided = true; announce eOutcome, (who = this, commit = false); }
      Post(net, coordinator, eVote, (from = this, yes = yes));
    }
    on eDecide do (commit: bool) {
      if (decided) { return; }
      decided = true;
      announce eOutcome, (who = this, commit = commit);
    }
  }
}

machine Coordinator {
  var net: machine;
  var buggy: bool;
  var participants: seq[machine];
  var votes: map[machine, bool];
  var begun: bool;
  var hasDecided: bool;

  start state Setup {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on eJoin do (ps: seq[machine]) { participants = ps; goto Running; }
  }

  state Running {
    on eBegin do {
      var p: machine;
      if (begun) { return; }
      begun = true;
      foreach (p in participants) { Post(net, p, ePrepare, null); }
    }
    on eVote do (v: (from: machine, yes: bool)) {
      var all: bool;
      var p: machine;
      var decision: bool;
      votes[v.from] = v.yes;
      if (hasDecided) { return; }
      all = sizeof(votes) == sizeof(participants);
      if (!(buggy || all || !v.yes)) { return; }
      if (buggy) { decision = v.yes; }
      else {
        decision = all;
        foreach (p in participants) { if (p in votes && !votes[p]) { decision = false; } }
      }
      hasDecided = true;
      foreach (p in participants) { Post(net, p, eDecide, decision); }
    }
  }
}

event eJoin: seq[machine];

// People: begin once, and each participant votes once, yes or no, in any order and at any time.
machine People {
  start state Acting {
    entry (config: (coordinator: machine, participants: seq[machine])) {
      var order: seq[int];
      var i: int;
      var acted: set[int];
      send config.coordinator, eBegin;
      while (sizeof(acted) < sizeof(config.participants)) {
        i = choose(sizeof(config.participants));
        if (!(i in acted)) {
          acted += (i);
          send config.participants[i], eVoteNow, $;
        }
      }
    }
  }
}
