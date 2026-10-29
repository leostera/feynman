// The customer is never charged twice.
spec ChargedOnce observes eBankCharged {
  var charged: set[int];
  start state Watching {
    on eBankCharged do (payment: int) {
      assert !(payment in charged), "the customer was charged twice";
      charged += (payment);
    }
  }
}
