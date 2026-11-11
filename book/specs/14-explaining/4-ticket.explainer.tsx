// Figures for 4-ticket.explainer.md: a few parts at a time, drawn with the playground's pieces
// from recorded runs, for the points the whole stage would bury.
import { Actor, Diagram, Message } from "@leostera/feynman/explain";

const buys = { scenario: "Alice buys the last seat" };
const noKey = { breaks: "idempotencyKey" };
const noRearm = { breaks: "rearmHolds" };

/** The two steps of a sale, and where the order number goes. */
export function HoldThenPay() {
  return (
    <Diagram caption="“Alice buys the last seat”, after event 5: the box office has the seat as paying, and the charge is on its way.">
      <Actor run={buys} at={5} name="Alice" />
      <Message name="hold, then pay" />
      <Actor run={buys} at={5} name="Box office" />
      <Message name="Charge order-1" note="the order number travels with the money" />
      <Actor run={buys} at={5} name="Bank" />
    </Diagram>
  );
}

/** Without the key: one charge in, two charges out. */
export function DoubleCharge() {
  return (
    <Diagram caption="Without idempotencyKey, at the event that breaks chargedOnce.">
      <Actor run={noKey} at="broke" name="Box office" />
      <Message name="Charge order-1" fate="twice" note="the network delivers it twice" />
      <Actor run={noKey} at="broke" name="Bank" />
    </Diagram>
  );
}

/** A restart keeps the database and loses the timer. */
export function ForgottenTimer() {
  return (
    <Diagram caption="Without rearmHolds: the box office before its restart (event 2) and after it (event 3).">
      <Actor run={noRearm} at={2} name="Box office" />
      <Message name="restart" tone="refused" note="memory and timers are gone; the database stays" />
      <Actor run={noRearm} at={3} name="Box office" />
    </Diagram>
  );
}
