// The shop never credits more than the payments it was notified of.
spec CreditedOnce observes eNotified, eCredited {
  var notified: int;
  var credited: int;
  start state Watching {
    on eNotified do (id: int) { notified = notified + 1; }
    on eCredited do (id: int) {
      credited = credited + 1;
      assert credited <= notified, "the shop credited more than it was notified of";
    }
  }
}
