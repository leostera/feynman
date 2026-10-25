import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * The real path of `path`, resolving symlinks in its existing ancestors, so paths
 * from different sources compare equal (on macOS, /var is a symlink to /private/var
 * and git reports the latter).
 */
export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(canonical(parent), basename(path));
  }
}

/** `path` (relative to `cwd`) as a path inside `root`, or null when outside it. */
export function within(root: string, cwd: string, path: string): string | null {
  const file = relative(canonical(root), canonical(isAbsolute(path) ? path : resolve(cwd, path)));
  return file && !file.startsWith("..") && !isAbsolute(file) ? file : null;
}
