// Restarts, as Feynman sees them: within a fault budget, any instance may restart at any
// moment. The instance handles eRestart by dropping what is not durable; timers it set fire
// into a new generation and are ignored.
event eRestart;
event eChaosStep;

machine Chaos {
  var victims: seq[machine];
  var budget: int;
  start state Waiting {
    entry (config: (victims: seq[machine], budget: int)) {
      victims = config.victims;
      budget = config.budget;
      if (budget > 0) { send this, eChaosStep; }
    }
    on eChaosStep do {
      if (budget == 0) { return; }
      if ($) {
        budget = budget - 1;
        send victims[choose(sizeof(victims))], eRestart;
        return;
      }
      send this, eChaosStep;
    }
  }
}
