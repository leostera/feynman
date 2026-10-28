// The states the search has seen: each 64-bit fingerprint (keys.ts) and the node it names,
// in flat typed arrays, since a big search sees millions.

/** Fingerprint → node, by open addressing. Fingerprint (0, 0) is stored as (0, 1): (0, 0) marks an empty slot. */
export class PrintMap {
  private hi = new Uint32Array(1 << 12);
  private lo = new Uint32Array(1 << 12);
  private node = new Int32Array(1 << 12);
  size = 0;

  /** The node with this fingerprint, if any. */
  get(hi: number, lo: number): number | undefined {
    hi >>>= 0;
    lo >>>= 0;
    if (hi === 0 && lo === 0) lo = 1;
    const mask = this.hi.length - 1;
    for (let i = slotOf(hi, lo, mask); ; i = (i + 1) & mask) {
      if (this.hi[i] === 0 && this.lo[i] === 0) return undefined;
      if (this.hi[i] === hi && this.lo[i] === lo) return this.node[i];
    }
  }

  /** Remember a fingerprint that is not here yet. */
  set(hi: number, lo: number, node: number): void {
    if ((this.size + 1) * 2 > this.hi.length) this.grow();
    this.put(...nonzero(hi, lo), node);
    this.size++;
  }

  private put(hi: number, lo: number, node: number): void {
    const mask = this.hi.length - 1;
    let i = slotOf(hi, lo, mask);
    while (this.hi[i] !== 0 || this.lo[i] !== 0) i = (i + 1) & mask;
    this.hi[i] = hi;
    this.lo[i] = lo;
    this.node[i] = node;
  }

  private grow(): void {
    const { hi, lo, node } = this;
    this.hi = new Uint32Array(hi.length * 2);
    this.lo = new Uint32Array(hi.length * 2);
    this.node = new Int32Array(hi.length * 2);
    for (let i = 0; i < hi.length; i++) if (hi[i] !== 0 || lo[i] !== 0) this.put(hi[i], lo[i], node[i]);
  }
}

/** Both halves as unsigned 32-bit numbers, with (0, 0) moved to (0, 1). */
function nonzero(hi: number, lo: number): [number, number] {
  hi >>>= 0;
  lo >>>= 0;
  return hi === 0 && lo === 0 ? [0, 1] : [hi, lo];
}

function slotOf(hi: number, lo: number, mask: number): number {
  return (lo ^ Math.imul(hi, 0x9e3779b1)) & mask;
}
