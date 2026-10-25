// Anchors: where model elements point into the repository.

/** Parse either anchor form into `{ file, start?, end? }` (lines). */
export function parseAnchor(anchor) {
  if (typeof anchor !== "string") return { file: anchor.file, start: anchor.span?.start.line, end: anchor.span?.end?.line };
  const match = /^([^#:]+)(?::(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?)?(?:#.+)?$/.exec(anchor);
  if (!match) return { file: anchor };
  const [, file, start, end] = match;
  return { file, start: start && Number(start), end: end && Number(end) };
}

/** Every anchor in a model or element (anchors, evidence, tests, definitions, call-path frames), parsed. */
export function modelAnchors(model) {
  const anchors = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      for (const key of ["anchors", "evidence", "tests", "definitions"]) {
        if (Array.isArray(value[key])) for (const anchor of value[key]) anchors.push(parseAnchor(anchor));
      }
      if (value.anchor) anchors.push(parseAnchor(value.anchor));
      Object.values(value).forEach(collect);
    }
  };
  collect(model);
  return anchors.filter((anchor) => anchor.file);
}

/** Files a model or element anchors directly (footprints do not count). */
export function anchoredFiles(model) {
  return new Set(modelAnchors(model).map((anchor) => anchor.file));
}

