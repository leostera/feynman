// No replica ever goes back to an older version than one it held.
spec NeverGoesBack observes eWentBack {
  start state Watching {
    on eWentBack do { assert false, "a replica went back to an older version"; }
  }
}
