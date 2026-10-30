// The seats table, as the server sees it. One row per seat; tonight, one seat is left.
export type SeatRow =
  | { seat: string; state: "free" }
  | { seat: string; state: "held"; holder: string; order: string; expiresAt: Date }
  | { seat: string; state: "paying"; payer: string; order: string }
  | { seat: string; state: "sold"; buyer: string };

export interface Db {
  /** `UPDATE seats SET state = 'held', … WHERE seat = $1 AND state = 'free' RETURNING *`. */
  holdIfFree(seat: string, holder: string, order: string, expiresAt: Date): Promise<SeatRow | null>;
  /** `UPDATE seats SET state = 'paying', payer = $2 WHERE seat = $1 AND state = 'held' AND holder = $2`. */
  startPayment(seat: string, payer: string): Promise<SeatRow | null>;
  /** `UPDATE seats SET state = 'sold', buyer = payer WHERE seat = $1 AND state = 'paying' AND order = $2`. */
  markSold(seat: string, order: string): Promise<SeatRow | null>;
  /** `UPDATE seats SET state = 'free' WHERE seat = $1 AND state = 'held' AND order = $2`. */
  releaseHold(seat: string, order: string): Promise<void>;
  /** Every row in `held` or `paying`, for the server to pick up after a restart. */
  unfinished(): Promise<SeatRow[]>;
}
