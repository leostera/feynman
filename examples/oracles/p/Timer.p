// A timer, as Feynman sees it: once set, it may fire at any moment (the network may be slower
// than it). Setting it again replaces it, and cancelling it makes a late firing a no-op: the
// owner ignores a firing whose generation is not its current one.
event eArm: (owner: machine, generation: int);
event eFire: int;

machine Timer {
  start state Idle {
    on eArm do (a: (owner: machine, generation: int)) { send a.owner, eFire, a.generation; }
  }
}
