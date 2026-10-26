// The bank debits once per payment, however often it is asked.
spec DebitedOnce observes ePaid, eDebitMade {
  var paid: int;
  var debits: int;
  start state Watching {
    on ePaid do { paid = paid + 1; }
    on eDebitMade do {
      debits = debits + 1;
      assert debits <= paid, "the bank debited more often than the client paid";
    }
  }
}
