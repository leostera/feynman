// What the explorer remembers between visits. A page served sandboxed (the share service
// serves pages built from anyone's repository in an origin of their own) has no storage at
// all: reading it throws. There, settings last as long as the page.
const memory = new Map<string, string>();

export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}
