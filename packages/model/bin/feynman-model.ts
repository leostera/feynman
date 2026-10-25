#!/usr/bin/env node
// Command-line access to the model tools.
//
//   feynman-model check    <model-dir> [<repository>]
//   feynman-model coverage <repository> <model-dir> [--missing]
//   feynman-model measure  <repository> <model-dir> [--main <ref>]
//   feynman-model index    <model-dir> [<kind>…]
import { checkModel, computeCoverage, CoverageError, describeCoverage, groupMissing, indexModel, KINDS, loadModel, measureModel } from "../src/index.ts";

const [command, ...args] = process.argv.slice(2);
const usage = (): never => {
  console.error("usage: feynman-model check|coverage|measure|index …");
  process.exit(2);
};

switch (command) {
  case "check": {
    const [modelDir, repository] = args;
    if (!modelDir) usage();
    const problems = checkModel(modelDir, repository);
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      console.error(`${problems.length} problem(s)`);
      process.exit(1);
    }
    const model = loadModel(modelDir);
    console.log(`ok: ${KINDS.map((kind) => `${model[kind.key].length} ${kind.key}`).join(", ")}`);
    break;
  }
  case "coverage": {
    const [repository, modelDir, flag] = args;
    if (!repository || !modelDir) usage();
    let report: ReturnType<typeof computeCoverage>;
    try {
      report = computeCoverage(repository, modelDir);
    } catch (error) {
      if (!(error instanceof CoverageError)) throw error;
      console.error((error as Error).message);
      process.exit(1);
    }
    if (flag === "--missing") {
      for (const path of report.missing) console.log(path);
      process.exit(report.missing.length ? 1 : 0);
    }
    console.log(describeCoverage(report));
    if (report.deleted.length) console.log(`${report.deleted.length} deleted; check reports any anchor still pointing at them`);
    if (report.stale.length) console.log(`ignored ledgers for other commits: ${report.stale.join(", ")}`);
    if (report.unknown.length) console.log(`ledgers name ${report.unknown.length} paths not in the snapshot, e.g. ${report.unknown.slice(0, 3).join(", ")}`);
    for (const problem of report.problems) console.log(problem);
    if (report.missing.length) {
      console.log("uncovered:");
      for (const [group, n] of groupMissing(report.missing)) console.log(`  ${String(n).padStart(4)}  ${group}`);
      process.exit(1);
    }
    break;
  }
  case "measure": {
    const [repository, modelDir, flag, ref] = args;
    if (!repository || !modelDir) usage();
    console.log(measureModel(repository, modelDir, flag === "--main" && ref ? ref : "main"));
    break;
  }
  case "index": {
    const [modelDir, ...only] = args;
    if (!modelDir) usage();
    console.log(indexModel(modelDir, only));
    break;
  }
  default:
    usage();
}
