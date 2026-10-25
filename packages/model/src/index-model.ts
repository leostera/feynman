// A one-line-per-element overview of a model, so an agent can see what exists
// without loading every file.
import { KINDS, loadModel } from "./model.ts";

export function indexModel(modelDir: string, only: string[] = []): string {
  const model = loadModel(modelDir);
  const oneLine = (text = "") => (text.length > 120 ? `${text.slice(0, 117)}…` : text).replace(/\s+/g, " ");
  const describe = (e: Record<string, unknown>): string => String(e.summary ?? e.statement ?? (e.subject ? `${e.subject}: ${e.value}` : ""));
  const out = [`${model.meta.system} @ ${String(model.meta.source?.commit).slice(0, 7)}: ${oneLine(model.meta.summary)}`];
  for (const kind of KINDS) {
    if (only.length && !only.includes(kind.dir) && !only.includes(kind.key)) continue;
    out.push("", `${kind.dir}/ (${model[kind.key].length})`);
    for (const element of model[kind.key]) out.push(`  ${element.id}  ${oneLine(describe(element as unknown as Record<string, unknown>))}`);
  }
  return out.join("\n");
}
