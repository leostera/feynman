// Type-checking specs: the DSL's types catch most mistakes (an unknown message, a send not
// declared, a missing input) before anything runs. A repository need not install anything:
// tsc runs from this installation with a temporary config mapping `@leostera/feynman` here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CONFIG_NAMES, PLAY_NAMES, SPEC_NAMES } from "./names.ts";

const TSC = join(dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)), "bin", "tsc");
const SPEC = Bun.resolveSync("../spec/index.ts", import.meta.dir);
const CLI = Bun.resolveSync("./index.ts", import.meta.dir);
const PLAY = Bun.resolveSync("../play/index.ts", import.meta.dir);
const PLAY_DIR = dirname(PLAY);
const REACT_TYPES = dirname(Bun.resolveSync("@types/react/package.json", PLAY_DIR));
const KUMO = dirname(Bun.resolveSync("@cloudflare/kumo/package.json", PLAY_DIR));

export interface TypeError {
  file: string;
  line: number;
  column: number;
  message: string;
}

/** Type errors in the given spec and playground files (repository-relative), or [] when they check. */
export function typecheck(root: string, files: string[]): TypeError[] {
  if (!files.length) return [];
  const dir = mkdtempSync(join(tmpdir(), "feynman-types-"));
  const config = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      lib: ["ES2023", "DOM"],
      module: "ESNext",
      moduleResolution: "Bundler",
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      jsx: "react-jsx",
      types: [],
      paths: {
        ...Object.fromEntries(SPEC_NAMES.map((n) => [n, [SPEC]])),
        ...Object.fromEntries(CONFIG_NAMES.map((n) => [n, [CLI]])),
        ...Object.fromEntries(PLAY_NAMES.map((n) => [n, [PLAY]])),
        react: [join(REACT_TYPES, "index.d.ts")],
        "react/*": [join(REACT_TYPES, "*")],
        "@cloudflare/kumo": [KUMO],
      },
    },
    files: files.map((f) => join(root, f)),
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config));
  // tsc prints paths relative to its working directory, which it reads from PWD: run it in
  // the repository's real directory, past any symlink like /tmp, and say so in PWD too.
  const real = realpathSync(root);
  const out = spawnSync(TSC, ["-p", join(dir, "tsconfig.json"), "--pretty", "false"], { encoding: "utf8", cwd: real, env: { ...process.env, PWD: real } });
  const errors: TypeError[] = [];
  const fromRoot = (path: string): string => {
    const absolute = resolve(real, path);
    try {
      return relative(real, realpathSync(absolute));
    } catch {
      return relative(real, absolute);
    }
  };
  let last: TypeError | null = null;
  for (const line of (out.stdout + out.stderr).split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS\d+: (.*)$/.exec(line);
    if (m) {
      last = { file: fromRoot(m[1]), line: Number(m[2]), column: Number(m[3]), message: hint(m[4]) };
      // Only the specs themselves: code they import may not type-check without its own setup.
      if (files.includes(last.file)) errors.push(last);
      else last = null;
    } else if (last && line.startsWith("  ")) last.message += `\n${line}`;
  }
  return errors;
}

/** Errors that have a known cause in specs get a line saying what to do. */
function hint(message: string): string {
  if (/referenced directly or indirectly in its own initializer/.test(message))
    return `${message}\n  Two actors refer to each other in functions whose return type TypeScript must infer, usually input examples. Give that function a return type, like examples: (w): string[] => …`;
  return message;
}
