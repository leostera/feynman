// An independent model of examples/raft-vote.ts, in P: three nodes and one term. A restart
// (from the Chaos machine) forgets a node's votes and leadership, and, buggy, its own vote.
event eRequestVote: machine;
event eVote: machine;
event eCampaign;
event ePeers: seq[machine];
event eLeads: machine;

machine Node {
  var net: machine;
  var buggy: bool;
  var peers: seq[machine];
  var voted: bool;
  var votes: set[machine];
  var leader: bool;
  start state Running {
    entry (config: (net: machine, buggy: bool)) { net = config.net; buggy = config.buggy; }
    on ePeers do (p: seq[machine]) { peers = p; }
    on eCampaign do {
      var i: int;
      if (voted) { return; }
      voted = true;
      votes += (this);
      while (i < sizeof(peers)) {
        if (peers[i] != this) { Post(net, peers[i], eRequestVote, this); }
        i = i + 1;
      }
    }
    on eRequestVote do (candidate: machine) {
      if (voted) { return; }
      voted = true;
      Post(net, candidate, eVote, this);
    }
    on eVote do (voter: machine) {
      if (voter in votes) { return; }
      votes += (voter);
      if (sizeof(votes) >= 2 && !leader) {
        leader = true;
        announce eLeads, this;
      }
    }
    on eRestart do {
      if (buggy) { voted = false; }
      votes = default(set[machine]);
      if (leader) { announce eDeposed, this; }
      leader = false;
    }
  }
}

event eDeposed: machine;

// People: any node may campaign, at any moment, at most twice.
machine People {
  var nodes: seq[machine];
  var left: int;
  start state Acting {
    entry (ns: seq[machine]) { nodes = ns; left = 6; send this, eStep; }
    on eStep do {
      if (left == 0) { return; }
      if ($) {
        left = left - 1;
        send nodes[choose(sizeof(nodes))], eCampaign;
      }
      send this, eStep;
    }
  }
}
