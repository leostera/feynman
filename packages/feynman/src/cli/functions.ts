// The code of every function a spec's call trees reach, for the Code view to open in place:
// read once per definition (a function called from many steps is kept once), cut to its lines,
// and highlighted like the sources the steps name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { functionId, type CallNode, type FunctionCode } from "../view/data.ts";
import { highlightLines } from "./highlight.ts";

export async function functionCode(root: string, fileUrl: string | null, trees: Record<string, CallNode>): Promise<Record<string, FunctionCode>> {
  const defs = new Map<string, NonNullable<CallNode["def"]>>();
  const visit = (node: CallNode) => {
    if (!node.external && node.def) defs.set(functionId(node.def), node.def);
    node.children.forEach(visit);
  };
  Object.values(trees).forEach(visit);

  const files = new Map<string, string[] | null>();
  const linesOf = (file: string) => {
    if (!files.has(file)) {
      try {
        files.set(file, readFileSync(join(root, file), "utf8").split("\n"));
      } catch {
        files.set(file, null);
      }
    }
    return files.get(file);
  };

  const out: Record<string, FunctionCode> = {};
  for (const [id, def] of defs) {
    const lines = linesOf(def.file);
    if (!lines) continue;
    const text = lines.slice(def.line - 1, def.endLine).join("\n");
    const highlighted = await highlightLines(def.file, text).catch(() => null);
    const url = fileUrl ? `${fileUrl.replace("{path}", def.file)}${/gitlab/.test(fileUrl) ? `#L${def.line}-${def.endLine}` : `#L${def.line}-L${def.endLine}`}` : undefined;
    out[id] = { file: def.file, start: def.line, end: def.endLine, text, ...(highlighted ? { lines: highlighted } : {}), ...(url ? { url } : {}) };
  }
  return out;
}
