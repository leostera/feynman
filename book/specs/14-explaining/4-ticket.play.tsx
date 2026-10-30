// Chapter 14, step 4: what the derived playground can't show by itself. The ticket is drawn
// as a ticket, and the bank opens a card statement beside its node once it has charged.
import { Card, definePlayground, Panel, Ticket } from "@leostera/feynman/play";
import spec, { Bank, BoxOffice, Person } from "./4-ticket.ts";

export default definePlayground(spec, (play) => {
  play.token("ticket", ({ token, holder }) => <Ticket code={String(token.value)} label={`${holder.label}'s ticket`} />);

  play.actor(Bank, {
    panel: ({ state }) =>
      state.charges.length === 0 ? null : (
        <Panel title="Card statement">
          {state.charges.map((order, i) => (
            <Card key={i} title={order}>
              {state.charges.indexOf(order) === i ? "Box office, seat A1" : "Box office, seat A1 (again!)"}
            </Card>
          ))}
        </Panel>
      ),
  });

  // The sequence diagram reads left to right as the money moves.
  play.flow("Alice buys the last seat", [Person, BoxOffice, Bank]);
});
