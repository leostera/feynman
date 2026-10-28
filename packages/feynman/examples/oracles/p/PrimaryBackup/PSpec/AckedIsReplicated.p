// Every write the client was told succeeded is on the backup.
spec AckedIsReplicated observes eAcked, eBackedUp {
  var acked: int;
  var backedUp: int;
  start state Watching {
    on eBackedUp do { backedUp = backedUp + 1; }
    on eAcked do {
      acked = acked + 1;
      assert acked <= backedUp, "acknowledged a write the backup does not have";
    }
  }
}
