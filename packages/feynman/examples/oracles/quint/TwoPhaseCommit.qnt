// An independent model of examples/two-phase-commit.ts, in Quint, for Apalache. A coordinator
// asks two participants to prepare; each votes; the coordinator decides once it can (fixed) or
// on the first vote (buggy) and tells everyone. The network is a bag: a count of copies per
// message. A fault loses a message, or restarts a participant, which keeps everything (its
// fields are durable): a restart only spends the budget. The harness sets BUGGY, FAULTS and
// REPEATS.
module TwoPhaseCommit {
  const BUGGY: bool
  const FAULTS: int
  const REPEATS: int

  pure val PARTICIPANTS = Set("a", "b")
  // A message: its kind, the participant it is to or from, and a vote or decision ("" for none).
  type Message = { kind: str, who: str, value: str }
  pure val MESSAGES: Set[Message] =
    PARTICIPANTS.map(p => { kind: "Prepare", who: p, value: "" })
      .union(tuples(PARTICIPANTS, Set("yes", "no")).map(((p, v)) => { kind: "Vote", who: p, value: v }))
      .union(tuples(PARTICIPANTS, Set("commit", "abort")).map(((p, d)) => { kind: "Decide", who: p, value: d }))

  var prepared: str -> bool
  var vote: str -> str
  var outcome: str -> str
  var voted: str -> int
  var begun: bool
  var begins: int
  var votes: str -> str
  var decided: str
  var net: Message -> int
  var faults: int

  pure def send(bag: Message -> int, ms: Set[Message]): Message -> int = ms.fold(bag, (b, m) => b.setBy(m, n => n + 1))
  pure def take(bag: Message -> int, m: Message): Message -> int = bag.setBy(m, n => n - 1)

  action init = all {
    prepared' = PARTICIPANTS.mapBy(_ => false), vote' = PARTICIPANTS.mapBy(_ => ""), outcome' = PARTICIPANTS.mapBy(_ => ""),
    voted' = PARTICIPANTS.mapBy(_ => 0), begun' = false, begins' = 0, votes' = PARTICIPANTS.mapBy(_ => ""), decided' = "",
    net' = MESSAGES.mapBy(_ => 0), faults' = 0,
  }

  action keepParticipants = all { prepared' = prepared, vote' = vote, outcome' = outcome, voted' = voted }
  action keepCoordinator = all { begun' = begun, begins' = begins, votes' = votes, decided' = decided }

  action begin = all {
    not(begun), begins < REPEATS,
    begun' = true, begins' = begins + 1,
    net' = net.send(PARTICIPANTS.map(p => { kind: "Prepare", who: p, value: "" })),
    votes' = votes, decided' = decided, keepParticipants, faults' = faults,
  }

  action castVote(p: str, v: str): bool = all {
    prepared.get(p), vote.get(p) == "", voted.get(p) < REPEATS,
    vote' = vote.set(p, v),
    outcome' = if (v == "no") outcome.set(p, "abort") else outcome,
    voted' = voted.setBy(p, n => n + 1),
    net' = net.send(Set({ kind: "Vote", who: p, value: v })),
    prepared' = prepared, keepCoordinator, faults' = faults,
  }

  action deliver(m: Message): bool = all {
    net.get(m) > 0, faults' = faults,
    if (m.kind == "Prepare") all {
      prepared' = prepared.set(m.who, true), net' = net.take(m),
      vote' = vote, outcome' = outcome, voted' = voted, keepCoordinator,
    } else if (m.kind == "Decide") all {
      outcome' = if (outcome.get(m.who) == "") outcome.set(m.who, m.value) else outcome, net' = net.take(m),
      prepared' = prepared, vote' = vote, voted' = voted, keepCoordinator,
    } else {
      // A vote: count it, and decide on every vote (buggy), or once all are in or one is no.
      val counted = votes.set(m.who, m.value)
      val everyone = PARTICIPANTS.forall(q => counted.get(q) != "")
      val decidesNow = decided == "" and (BUGGY or everyone or m.value == "no")
      val commit = if (BUGGY) m.value == "yes" else everyone and PARTICIPANTS.forall(q => counted.get(q) == "yes")
      val decision = if (commit) "commit" else "abort"
      all {
        votes' = counted,
        decided' = if (decidesNow) decision else decided,
        net' = if (decidesNow) net.take(m).send(PARTICIPANTS.map(q => { kind: "Decide", who: q, value: decision })) else net.take(m),
        begun' = begun, begins' = begins, keepParticipants,
      }
    },
  }

  action lose(m: Message): bool = all {
    faults < FAULTS, net.get(m) > 0, net' = net.take(m), faults' = faults + 1, keepParticipants, keepCoordinator,
  }
  // Everything a participant has is durable: a restart only spends the budget.
  action restart = all { faults < FAULTS, faults' = faults + 1, net' = net, keepParticipants, keepCoordinator }
  action nothing = all { net' = net, faults' = faults, keepParticipants, keepCoordinator }

  action step = any {
    begin, restart, nothing,
    nondet p = PARTICIPANTS.oneOf()
    nondet v = Set("yes", "no").oneOf()
    castVote(p, v),
    nondet m = MESSAGES.oneOf()
    any { deliver(m), lose(m) },
  }

  val atomic = not(PARTICIPANTS.exists(p => PARTICIPANTS.exists(q => outcome.get(p) == "commit" and outcome.get(q) == "abort")))
  val quiet = MESSAGES.forall(m => net.get(m) == 0)
  val decidedOnceQuiet = (quiet and PARTICIPANTS.forall(p => vote.get(p) != "")) implies decided != ""
}
