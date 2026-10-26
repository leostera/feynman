// No job has its side effect twice.
spec DoneOnce observes eEnqueued, eEffect {
  var enqueued: int;
  var effects: int;
  start state Watching {
    on eEnqueued do { enqueued = enqueued + 1; }
    on eEffect do {
      effects = effects + 1;
      assert effects <= enqueued, "a job had its side effect twice";
    }
  }
}
