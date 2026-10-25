// Which repository files the agent has actually looked at in this session.
//
// A file counts as seen when the agent read it with the `read` tool, or named it in a
// `bash` command (cat, sed, rg, git show, …). Recording a file as reviewed requires
// having seen it; that is the only enforcement. The agent is free to wander between
// files in whatever order the code leads it.
import { isAbsolute, relative, resolve } from "node:path";

export class Evidence {
  private seen = new Set<string>();

  constructor(private readonly repository: string) {}

  has(path: string): boolean {
    return this.seen.has(path);
  }

  /** A `read` call on `path`, relative to `cwd`. */
  read(cwd: string, path: string) {
    const file = this.toRepository(cwd, path);
    if (file) this.seen.add(file);
  }

  /** A `bash` command run in `cwd`: every token that names a file in the repository. */
  bash(cwd: string, command: string, tracked: Set<string>) {
    for (const token of command.split(/[\s'"`;|&<>()=]+/)) {
      if (!token || token.startsWith("-")) continue;
      // `git show <rev>:<path>` names a file after the colon.
      const candidates = token.includes(":") ? [token, token.slice(token.indexOf(":") + 1)] : [token];
      for (const candidate of candidates) {
        const file = this.toRepository(cwd, candidate);
        if (file && tracked.has(file)) this.seen.add(file);
        else if (tracked.has(candidate)) this.seen.add(candidate);
      }
    }
  }

  private toRepository(cwd: string, path: string): string | null {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const file = relative(this.repository, absolute);
    return file && !file.startsWith("..") && !isAbsolute(file) ? file : null;
  }
}
