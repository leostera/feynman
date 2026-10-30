// The box office's web server: holds, payments, expiries, and what it does after a restart.
import { charge } from "./bank.ts";
import type { Db } from "./db.ts";

export const HOLD_MINUTES = 10;
const SEAT = "A1";

/** Timers set in this process, by order. A restart loses them; `onStartup` sets them again. */
const expiries = new Map<string, ReturnType<typeof setTimeout>>();

export async function handleHold(db: Db, person: string): Promise<{ held: boolean }> {
  const order = crypto.randomUUID();
  const row = await db.holdIfFree(SEAT, person, order, new Date(Date.now() + HOLD_MINUTES * 60_000));
  if (!row) return { held: false };
  scheduleExpiry(db, order);
  return { held: true };
}

export async function handlePay(db: Db, person: string): Promise<{ ticket: boolean }> {
  const row = await db.startPayment(SEAT, person);
  if (!row || row.state !== "paying") return { ticket: false };
  clearTimeout(expiries.get(row.order));
  await chargeUntilAnswered(row.order);
  return { ticket: (await db.markSold(SEAT, row.order)) !== null };
}

/** The charge, again and again until the bank answers. Safe because the order is the idempotency key. */
export async function chargeUntilAnswered(order: string): Promise<void> {
  for (;;) {
    try {
      await charge(order);
      return;
    } catch {
      // The call failed: the bank may or may not have charged. Ask again with the same key.
    }
  }
}

export function scheduleExpiry(db: Db, order: string): void {
  expiries.set(order, setTimeout(() => void onHoldExpired(db, order), HOLD_MINUTES * 60_000));
}

export async function onHoldExpired(db: Db, order: string): Promise<void> {
  expiries.delete(order);
  await db.releaseHold(SEAT, order);
}

/** After a restart: every hold gets its timer back, and every payment in progress is charged again. */
export async function onStartup(db: Db): Promise<void> {
  for (const row of await db.unfinished()) {
    if (row.state === "held") scheduleExpiry(db, row.order);
    if (row.state === "paying") await resumePayment(db, row.order);
  }
}

export async function resumePayment(db: Db, order: string): Promise<void> {
  await chargeUntilAnswered(order);
  await db.markSold(SEAT, order);
}
