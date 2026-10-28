// No job is ever charged twice.
spec ChargedOnce observes eCharged {
  var charged: set[int];
  start state Watching {
    on eCharged do (job: int) {
      assert !(job in charged), "a job was charged twice";
      charged += (job);
    }
  }
}
