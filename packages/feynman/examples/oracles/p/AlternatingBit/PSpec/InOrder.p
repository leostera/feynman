// The receiver has the items in order, each once.
spec InOrder observes eKept {
  start state Watching {
    on eKept do (k: (position: int, value: int)) {
      assert k.position < 2 && k.value == k.position, "the receiver kept an item out of order";
    }
  }
}
