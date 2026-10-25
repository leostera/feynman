// Type-checking specs: the DSL's types catch most mistakes (an unknown message, a send not
// declared, a missing input) before anything runs. A repository need not install anything:
// tsc runs from this installation with a temporary config mapping `@feynman/spec` here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const TSC = join(dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)), "bin", "tsc");
const SPEC = Bun.resolveSync("@feynman/spec", import.meta.dir);
const CLI = Bun.resolveSync("./index.ts", import.meta.dir);

export interface TypeError {
  file: string;
  line: number;
  column: number;
  message: string;
}

/** Type errors in the given spec files (repository-relative), or [] when they check. */
export function typecheck(root: string, files: string[]): TypeError[] {
  if (!files.length) return [];
  const dir = mkdtempSync(join(tmpdir(), "feynman-types-"));
  const config = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      lib: ["ES2023"],
      module: "ESNext",
      moduleResolution: "Bundler",
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: [],
      paths: { "@feynman/spec": [SPEC], "@feynman/cli": [CLI] },
    },
    files: files.map((f) => join(root, f)),
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config));
  const out = spawnSync(TSC, ["-p", join(dir, "tsconfig.json"), "--pretty", "false"], { encoding: "utf8" });
  const errors: TypeError[] = [];
  let last: TypeError | null = null;
  for (const line of (out.stdout + out.stderr).split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS\d+: (.*)$/.exec(line);
    if (m) {
      last = { file: relative(root, m[1]), line: Number(m[2]), column: Number(m[3]), message: m[4] };
      // Only the specs themselves: code they import may not type-check without its own setup.
      if (files.includes(last.file)) errors.push(last);
      else last = null;
    } else if (last && line.startsWith("  ")) last.message += `\n${line}`;
  }
  return errors;
}
