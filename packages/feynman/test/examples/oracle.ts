// Comparing the checker with TLC, the TLA+ model checker, and with Alloy, on the same systems.
//
// Each oracle in examples/oracles is an independent TLA+ model of an example, following
// Feynman's semantics: the network is a bag, any message in it may go next, a fault (a step
// the spec declares, RFD0012) loses one or restarts an instance, and each instance takes each
// action at most twice (atMost(2)). TLC then gives the reachable states, which invariants break, and the shortest way there.
// The models in examples/oracles/alloy follow the same semantics for Alloy 6, which searches
// traces by SAT rather than states one by one: which invariants break, and the shortest way.
// Those in examples/oracles/spin do for SPIN, an explicit-state checker in C of its own: the
// reachable states, which invariants break, and the shortest way. Those in
// examples/oracles/nusmv do for NuSMV, which works on sets of states as BDDs: the reachable
// states, which invariants break and the shortest way, and the liveness verdicts.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, pendingText, type Bounds, type Report } from "../../src/check/index.ts";
import type { Spec, World } from "../../src/spec/index.ts";
import { sortedJson } from "../../src/spec/json.ts";

const JAR_PLACES = [process.env.TLA_TOOLS_JAR, "/Applications/TLA+ Toolbox.app/Contents/Eclipse/tla2tools.jar", "/opt/homebrew/share/tla2tools.jar"];

/**
 * A Java that runs: JAVA_HOME's, Homebrew's (keg-only, so not on PATH), or the one the TLA+
 * Toolbox bundles. macOS's /usr/bin/java is a stub that only says no runtime is installed.
 */
const JAVA_PLACES = [
  process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin", "java"),
  "/opt/homebrew/opt/openjdk/bin/java",
  "/usr/local/opt/openjdk/bin/java",
  "/Applications/TLA+ Toolbox.app/Contents/Eclipse/plugins/org.lamport.openjdk.macosx.x86_64_14.0.1.7/Contents/Home/bin/java",
  "java",
];
const JAVA = JAVA_PLACES.find((p): p is string => !!p && spawnSync(p, ["-version"]).status === 0);

/** Where tla2tools.jar is, if anywhere (set TLA_TOOLS_JAR to point at it), and only when a Java can run it. */
export const TLA_JAR = JAVA ? JAR_PLACES.find((p): p is string => !!p && existsSync(p)) : undefined;

export interface TlcResult {
  distinct: number;
  /** The invariant TLC found broken, and the events of its counterexample (states minus the first). */
  violated?: { invariant: string; events: number };
  /** Whether the temporal properties checked were violated. */
  temporal?: boolean;
}

export interface TlcOptions {
  view?: string;
  /** Where the module is: examples/oracles by default. */
  dir?: string;
  /** Check these temporal properties under this specification (with its fairness), not Init and Next. */
  temporal?: { specification: string; properties: string[] };
}

/** Run TLC on an oracle with these constants, checking the given invariants (none: just count states). */
export function tlc(module: string, constants: Record<string, string | number | boolean>, invariants: string[] = [], options: TlcOptions = {}): TlcResult {
  const dir = mkdtempSync(join(tmpdir(), "feynman-tlc-"));
  try {
    copyFileSync(join(options.dir ?? join(import.meta.dir, "..", "..", "examples", "oracles"), `${module}.tla`), join(dir, `${module}.tla`));
    const constantLines = Object.entries(constants).map(([k, v]) => `  ${k} = ${typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v}`);
    const behaviour = options.temporal ? [`SPECIFICATION ${options.temporal.specification}`, ...(options.temporal.properties.length ? ["PROPERTIES", ...options.temporal.properties.map((p) => `  ${p}`)] : [])] : ["INIT Init", "NEXT Next"];
    const cfg = [...(constantLines.length ? ["CONSTANTS", ...constantLines] : []), ...behaviour, ...(options.view ? [`VIEW ${options.view}`] : []), ...(invariants.length ? ["INVARIANTS", ...invariants.map((i) => `  ${i}`)] : [])];
    writeFileSync(join(dir, `${module}.cfg`), cfg.join("\n") + "\n");
    let out: string;
    try {
      out = execFileSync(JAVA!, ["-XX:+UseParallelGC", "-cp", TLA_JAR!, "tlc2.TLC", "-workers", "1", "-deadlock", "-metadir", join(dir, "meta"), module], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // TLC exits non-zero when it finds a violation; its output is still the report.
      out = String((error as { stdout?: string }).stdout ?? "");
    }
    const distinct = Number(/([\d,]+) distinct states? found/.exec(out)?.[1].replace(/,/g, "") ?? NaN);
    const broken = /Invariant (\w+) is violated/.exec(out);
    // A violation is an answer; any other error (an invariant that fails to evaluate, a bad
    // model) is not, and must not pass for "no violation".
    const errors = out.split("\n").filter((line) => line.startsWith("Error:") && !/^Error: (Invariant \w+ is violated|The behavior up to this point is|Temporal properties were violated|The following behavior constitutes a counter-example)/.test(line));
    if (errors.length || /Parsing or semantic analysis failed/.test(out) || Number.isNaN(distinct)) throw new Error(`TLC failed on ${module}:\n${out}`);
    const states = [...out.matchAll(/^State (\d+):/gm)].map((m) => Number(m[1]));
    const temporal = options.temporal ? { temporal: /Temporal properties were violated/.test(out) } : {};
    return { distinct, ...temporal, ...(broken ? { violated: { invariant: broken[1], events: Math.max(...states) - 1 } } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A world as TLA+ sees it: states with each instance's own variables (its action counters),
 * what is in flight (as a bag, no times), counters, the world's variables (the fault budget),
 * and what `never` properties remember.
 */
function projection(world: World, memory: string): string {
  return [
    world.instances.map((i) => `${i.id}=${sortedJson(i.state)}${i.variables ? `@${sortedJson(i.variables)}` : ""}`).sort().join("\n"),
    world.pending.map((p) => pendingText(p)).sort().join("\n"),
    sortedJson(world.fresh),
    sortedJson(world.variables ?? {}),
    memory,
  ].join("\n--\n");
}

/** The checker's exhaustive search, plain, and the distinct states it reached as TLA+ sees them. */
export async function feynman(spec: Spec, bounds: Partial<Bounds>): Promise<{ report: Report; distinct: number }> {
  const seen = new Set<string>();
  const report = await check(spec, { depth: 60, maxStates: 5_000_000, timeLimit: 300_000, walks: 0, symmetry: false, ...bounds }, [], { watch: { state: (w, memory) => seen.add(projection(w, memory)) } });
  return { report, distinct: seen.size };
}

/** Alloy 6's jar: ALLOY_JAR, or where Homebrew's alloy-analyzer puts it; only when a Java can run it. */
export const ALLOY_JAR = JAVA ? [process.env.ALLOY_JAR, ...alloyJars("/opt/homebrew/opt/alloy-analyzer/libexec")].find((p): p is string => !!p && existsSync(p)) : undefined;

/** The SAT solver Alloy uses: ALLOY_SOLVER, or SAT4J, its own, the fastest on these models. */
const ALLOY_SOLVER = process.env.ALLOY_SOLVER ?? "sat4j";

function alloyJars(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^org\.alloytools\.alloy\.dist.*\.jar$/.test(f)).map((f) => join(dir, f)) : [];
}

/**
 * Check `always <invariant>` on an Alloy model, examples/oracles/alloy/<module>.als, over its
 * traces from `init` taking a `step` at a time, of up to `steps` states, with Buggy, Faults and
 * Repeats set as given. Alloy tries trace lengths from the shortest up, so the first
 * counterexample is a shortest one: for each invariant, the events on it (states minus the
 * first), or undefined when none is that short.
 *
 * Alloy's integers wrap around, which could hide a counterexample or make one up. So each
 * model lists the integers it keeps (`fun counts`), and two checks show none overflows: they
 * start between -2 and 2, and a step grows the largest of their sizes by at most one, never
 * to the most negative integer (whose size does not fit). On a trace of n states they then
 * stay within n + 1 either way, and the integers have the bits for that.
 */
export function alloy(module: string, constants: { Buggy: boolean; Faults: number; Repeats: number }, invariants: string[], steps: number): Record<string, number | undefined> {
  // Counts reach at most steps + 1; the check on one step adds one more.
  const bits = Math.ceil(Math.log2(steps + 3)) + 1;
  const dir = mkdtempSync(join(tmpdir(), "feynman-alloy-"));
  try {
    const model = readFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", "alloy", `${module}.als`), "utf8");
    const scope = `for ${bits} Int`;
    const config = [
      `pred Buggy { ${constants.Buggy ? "" : "some none"} }`,
      `fun Faults: one Int { ${constants.Faults} }`,
      `fun Repeats: one Int { ${constants.Repeats} }`,
      `fun size_[c: Int]: Int { c < 0 implies minus[0, c] else c }`,
      `fun sizes_[s: set Int]: set Int { { n: Int | some c: s | n = size_[c] } }`,
      `check startSmall { init implies (all c: counts | -2 <= c and c <= 2) } ${scope}, 1 steps`,
      `check growSlowly { ((all c: counts | -${steps + 1} <= c and c <= ${steps + 1}) and step) implies (all c: counts' | c != min[Int] and size_[c] <= plus[max[sizes_[counts]], 1]) } ${scope}, 2 steps`,
      ...invariants.map((i) => `check ${i}_holds { (init and always step) implies always ${i} } ${scope}, 1..${steps} steps`),
    ];
    writeFileSync(join(dir, `${module}.als`), `${model}\n${config.join("\n")}\n`);
    const run = spawnSync(JAVA!, ["--enable-native-access=ALL-UNNAMED", "-jar", ALLOY_JAR!, "exec", "-f", "-q", "-s", ALLOY_SOLVER, "-t", "json", "-o", join(dir, "out"), join(dir, `${module}.als`)], { encoding: "utf8" });
    const receipt = join(dir, "out", "receipt.json");
    if (run.status !== 0 || !existsSync(receipt)) throw new Error(`Alloy failed on ${module}:\n${run.stdout}\n${run.stderr}`);
    const commands = JSON.parse(readFileSync(receipt, "utf8")).commands as Record<string, { solution?: { instances: unknown[] }[] }>;
    const ran = (name: string) => {
      const command = commands[name];
      if (!command) throw new Error(`Alloy did not run ${name} on ${module}`);
      return command.solution?.[0];
    };
    if (ran("startSmall")) throw new Error(`${module}: a count starts above 2 or below -2`);
    if (ran("growSlowly")) throw new Error(`${module}: a step moves a count further from zero by more than one`);
    return Object.fromEntries(invariants.map((i) => [i, ran(`${i}_holds`) ? ran(`${i}_holds`)!.instances.length - 1 : undefined]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** SPIN and a C compiler for the verifiers it writes, if both are around. */
export const HAS_SPIN = spawnSync("spin", ["-V"]).status === 0 && spawnSync("cc", ["--version"]).status === 0;

export interface SpinResult {
  /** Distinct states SPIN stored. */
  states: number;
  /** For each invariant, the events on a shortest counterexample, or undefined when it holds. */
  violated: Record<string, number | undefined>;
}

/**
 * Run SPIN on a Promela model, examples/oracles/spin/<model>.pml, with BUGGY, FAULTS and
 * REPEATS defined as given: every reachable state, breadth first, and each invariant (an
 * `ltl` claim `[] p` named p_<invariant>, as some names are Promela's keywords) on its own. A model is one process whose loop takes one
 * `d_step` per event, so SPIN's states are the model's variables and its steps are events; the
 * loop is an end state, as a world where nothing can happen is not an error here. SPIN's own
 * optimisations are off (-o1 -o2 -o3) when counting states: it would hide variables only ever
 * written, such as a count no step reads, and merge states the checker tells apart. The claims
 * keep statement merging, without which SPIN cannot search them breadth first.
 */
export function spin(model: string, constants: { Buggy: boolean; Faults: number; Repeats: number }, invariants: string[]): SpinResult {
  const dir = mkdtempSync(join(tmpdir(), "feynman-spin-"));
  const sh = (command: string, args: string[]) => {
    const run = spawnSync(command, args, { cwd: dir, encoding: "utf8" });
    if (run.error || (run.status !== 0 && command !== "./pan")) throw new Error(`${command} failed on ${model}:\n${run.stdout}${run.stderr}`);
    return `${run.stdout}${run.stderr}`;
  };
  try {
    copyFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", "spin", `${model}.pml`), join(dir, `${model}.pml`));
    const defines = [`-DBUGGY=${constants.Buggy ? 1 : 0}`, `-DFAULTS=${constants.Faults}`, `-DREPEATS=${constants.Repeats}`];
    // Every state, without the claims.
    sh("spin", ["-o1", "-o2", "-o3", ...defines, "-a", `${model}.pml`]);
    sh("cc", ["-O2", "-DBFS", "-DSAFETY", "-DNOCLAIM", "-o", "pan", "pan.c"]);
    const all = sh("./pan", ["-m100000"]);
    const states = Number(/(\d+) states, stored/.exec(all)?.[1] ?? NaN);
    if (!/errors: 0/.test(all) || Number.isNaN(states)) throw new Error(`SPIN failed on ${model}:\n${all}`);
    // Each claim, breadth first, so a counterexample is a shortest one.
    sh("spin", ["-o1", "-o2", ...defines, "-a", `${model}.pml`]);
    sh("cc", ["-O2", "-DBFS", "-DSAFETY", "-o", "pan", "pan.c"]);
    const violated: Record<string, number | undefined> = {};
    for (const invariant of invariants) {
      rmSync(join(dir, `${model}.pml.trail`), { force: true });
      const out = sh("./pan", ["-m100000", "-N", `p_${invariant}`]);
      if (/errors: 0/.test(out)) {
        violated[invariant] = undefined;
        continue;
      }
      if (!/assertion violated/.test(out) || !existsSync(join(dir, `${model}.pml.trail`))) throw new Error(`SPIN failed on ${model}, ${invariant}:\n${out}`);
      // The trail: a line per step, "step:process:transition"; negative steps are markers.
      const steps = readFileSync(join(dir, `${model}.pml.trail`), "utf8").split("\n").filter((line) => /^\d+:/.test(line));
      violated[invariant] = steps.length;
    }
    return { states, violated };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** NuSMV: NUSMV, or on PATH, or where a build from source installs it in ~/.local/opt. */
export const NUSMV = [process.env.NUSMV, "NuSMV", join(process.env.HOME ?? "", ".local", "opt", "nusmv", "bin", "NuSMV")].find((p): p is string => !!p && spawnSync(p, ["-h"]).status !== null && !spawnSync(p, ["-h"]).error);

export interface NusmvResult {
  /** Reachable states, as NuSMV counts them. */
  states: number;
  /** For each invariant, the events on a shortest counterexample, or undefined when it holds. */
  violated: Record<string, number | undefined>;
  /** For each liveness property, whether it is broken. */
  broken: Record<string, boolean>;
}

/**
 * Run NuSMV on a model, examples/oracles/nusmv/<model>.smv, with BUGGY, FAULTS and REPEATS
 * defined as given. A model's variables are the state; the step taken is an input variable
 * (IVAR), so it is not. Invariants are INVARSPECs and liveness properties LTLSPECs, by name,
 * under the model's JUSTICE constraints, which are Feynman's fairness (each fair step taken or
 * not possible, infinitely often). Counts saturate rather than overflow, so every model has an invariant `bounded`
 * that none reaches its top, and it must hold.
 */
export function nusmv(model: string, constants: { Buggy: boolean; Faults: number; Repeats: number }, invariants: string[], liveness: string[] = []): NusmvResult {
  const dir = mkdtempSync(join(tmpdir(), "feynman-nusmv-"));
  try {
    const source = readFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", "nusmv", `${model}.smv`), "utf8");
    writeFileSync(join(dir, `${model}.smv`), `${source}\nDEFINE BUGGY := ${constants.Buggy ? "TRUE" : "FALSE"}; FAULTS := ${constants.Faults}; REPEATS := ${constants.Repeats};\n`);
    const checks = [...["bounded", ...invariants].map((i) => `check_invar -P ${i}`), ...liveness.map((l) => `check_ltlspec -P ${l}`)];
    writeFileSync(join(dir, "run.cmd"), ["go", "print_reachable_states", ...checks, "quit"].join("\n") + "\n");
    const run = spawnSync(NUSMV!, ["-source", "run.cmd", `${model}.smv`], { cwd: dir, encoding: "utf8" });
    const out = `${run.stdout}${run.stderr}`;
    const states = Number(/reachable states: (\d+)/.exec(out)?.[1] ?? NaN);
    // Each check's verdict is a line "-- invariant …" or "-- specification …"; a counterexample follows it, a state at a time.
    const verdicts = out.split(/^(?=-- (?:invariant|specification) )/m).slice(1);
    if (Number.isNaN(states) || verdicts.length !== checks.length) throw new Error(`NuSMV failed on ${model}:\n${out}`);
    const holds = verdicts.map((v) => / is true\n/.test(v.split("\n").slice(0, 3).join("\n")));
    if (!holds[0]) throw new Error(`${model}: a count reaches the top of its range, where it saturates`);
    const violated: Record<string, number | undefined> = {};
    invariants.forEach((i, n) => {
      violated[i] = holds[n + 1] ? undefined : (verdicts[n + 1].match(/-> State: /g)?.length ?? 0) - 1;
    });
    const broken: Record<string, boolean> = {};
    liveness.forEach((l, n) => {
      broken[l] = !holds[invariants.length + 1 + n];
    });
    return { states, violated, broken };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readOracle(module: string): string {
  return readFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", `${module}.tla`), "utf8");
}
