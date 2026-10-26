// A switch flipped on and off, and a `never` property that counts how often it went on.
//
// After on-then-off the world is exactly as it started, so a search that merges states by
// the world alone never tries "on" a second time, and wrongly says it never happens. What
// the property remembers of the path (here: how often it went on) is part of the state.
//
// Expected: `onOnce` breaks in 3 steps (on, off, on).
import { defineSpec, message } from "@leostera/feynman";

export function lightSwitch() {
  return defineSpec("Switch", { messages: { Noop: message<{}>({ name: "noop" }) } }, (spec) => {
    const zone = spec.defineZone({ name: "Room" });
    const Switch = spec.defineActor({
      name: "Switch",
      zone,
      singleton: true,
      initialState: () => ({ on: false }),
      transitions: {
        up: { description: "Goes on.", when: (s) => !s.on, run: (s) => void (s.on = true) },
        down: { description: "Goes off.", when: (s) => s.on, run: (s) => void (s.on = false) },
      },
    });
    spec.defineInvariants({ onOnce: { description: "The switch never goes on twice.", never: (t) => t.count((e) => e.is(Switch, "up")) >= 2 } });
    return { Switch };
  });
}

export default lightSwitch();
