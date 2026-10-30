// The states the search has seen: each 64-bit fingerprint (keys.ts) and the node it names,
// in flat typed arrays, since a big search sees millions.

/**
 * Fingerprint → node, by open addressing, each slot three integers side by side (hi, lo, node),
 * so a probe reads one cache line. Fingerprint (0, 0) is stored as (0, 1): (0, 0) marks an empty slot.
 */
export class PrintMap {
  private slots = new Uint32Array(3 << 12);
  private mask = (1 << 12) - 1;
  size = 0;

  /** The node with this fingerprint, if any. */
  get(hi: number, lo: number): number | undefined {
    hi >>>= 0;
    lo >>>= 0;
    if (hi === 0 && lo === 0) lo = 1;
    const { slots, mask } = this;
    for (let i = slotOf(hi, lo, mask); ; i = (i + 1) & mask) {
      const at = i * 3;
      const h = slots[at];
      const l = slots[at + 1];
      if (h === 0 && l === 0) return undefined;
      if (h === hi && l === lo) return slots[at + 2] | 0;
    }
  }

  /** Remember a fingerprint that is not here yet. */
  set(hi: number, lo: number, node: number): void {
    if ((this.size + 1) * 2 > this.mask + 1) this.grow();
    hi >>>= 0;
    lo >>>= 0;
    if (hi === 0 && lo === 0) lo = 1;
    this.put(hi, lo, node);
    this.size++;
  }

  private put(hi: number, lo: number, node: number): void {
    const { slots, mask } = this;
    let i = slotOf(hi, lo, mask);
    while (slots[i * 3] !== 0 || slots[i * 3 + 1] !== 0) i = (i + 1) & mask;
    slots[i * 3] = hi;
    slots[i * 3 + 1] = lo;
    slots[i * 3 + 2] = node;
  }

  private grow(): void {
    const old = this.slots;
    this.mask = this.mask * 2 + 1;
    this.slots = new Uint32Array((this.mask + 1) * 3);
    for (let at = 0; at < old.length; at += 3) if (old[at] !== 0 || old[at + 1] !== 0) this.put(old[at], old[at + 1], old[at + 2]);
  }
}

function slotOf(hi: number, lo: number, mask: number): number {
  return (lo ^ Math.imul(hi, 0x9e3779b1)) & mask;
}
