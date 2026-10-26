// The names specs import Feynman by: the published package first, then the workspace names
// specs used before it was published, which still load so those specs keep working.
export const SPEC_NAMES = ["@leostera/feynman", "@feynman/spec"] as const;
export const PLAY_NAMES = ["@leostera/feynman/play", "@feynman/play"] as const;
export const CONFIG_NAMES = ["@leostera/feynman/config", "@feynman/cli"] as const;

/** Every name an import may use, for a bundler filter: exactly these, nothing under them. */
export function exactly(names: readonly string[]): RegExp {
  return new RegExp(`^(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`);
}
