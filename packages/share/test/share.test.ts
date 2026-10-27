import { describe, expect, test } from "bun:test";
import { asCommit, type Commit, parseAdvertisement, resolveRef } from "../src/refs.ts";
import { parseRepository } from "../src/repository.ts";

const A = "a".repeat(40) as Commit;
const B = "b".repeat(40) as Commit;
const C = "c".repeat(40) as Commit;

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

describe("parseRepository", () => {
  test("a host and a path", () => {
    expect(parseRepository("github.com/leostera/feynman")).toEqual({
      ok: true,
      repository: { host: "github.com", path: "leostera/feynman", url: "https://github.com/leostera/feynman", id: "github.com/leostera/feynman" },
    });
  });

  test("nested groups, a .git suffix, a trailing slash and an uppercase host", () => {
    const parsed = parseRepository("GitLab.com/a/b/c/d.git/");
    expect(parsed.ok && parsed.repository.id).toBe("gitlab.com/a/b/c/d");
  });

  test.each([
    ["", "no host"],
    ["github.com", "no path"],
    ["localhost/a/b", "localhost"],
    ["127.0.0.1/a/b", "an IP address"],
    ["github.com/../etc", "dot segments"],
    ["github.com/a/b%2F..%2F..", "encoded dot segments"],
    ["github.com/a/b%ZZ", "bad encoding"],
    ["github.com/a/.git", "an empty name"],
    ["github.com/a b/c", "spaces"],
  ])("rejects %j (%s)", (route) => {
    expect(parseRepository(route).ok).toBe(false);
  });
});

describe("parseAdvertisement", () => {
  test("refs, peeled tags, and capabilities after the first ref", () => {
    const body = [
      pkt("# service=git-upload-pack\n"),
      "0000",
      pkt(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`),
      pkt(`${A} refs/heads/main\n`),
      pkt(`${B} refs/tags/v1\n`),
      pkt(`${C} refs/tags/v1^{}\n`),
      "0000",
    ].join("");
    expect(parseAdvertisement(new TextEncoder().encode(body))).toEqual(
      new Map([["HEAD", A], ["refs/heads/main", A], ["refs/tags/v1", B], ["refs/tags/v1^{}", C]]),
    );
  });

  test("an empty repository has no refs", () => {
    const body = pkt("# service=git-upload-pack\n") + "0000" + pkt(`${"0".repeat(40)} capabilities^{}\0agent=git\n`) + "0000";
    expect(parseAdvertisement(new TextEncoder().encode(body))).toEqual(new Map());
  });

  test("anything else is not an advertisement", () => {
    expect(parseAdvertisement(new TextEncoder().encode("<html>sign in</html>"))).toBeNull();
  });
});

describe("resolveRef", () => {
  const refs = new Map<string, Commit>([
    ["HEAD", A],
    ["refs/heads/main", A],
    ["refs/heads/feature/x", B],
    ["refs/tags/v1", B],
    ["refs/tags/v1^{}", C],
  ]);

  test("no ref is HEAD", () => expect(resolveRef(refs, null)).toEqual({ kind: "commit", commit: A }));
  test("a branch", () => expect(resolveRef(refs, "feature/x")).toEqual({ kind: "commit", commit: B }));
  test("an annotated tag is its commit", () => expect(resolveRef(refs, "v1")).toEqual({ kind: "commit", commit: C }));
  test("a full ref", () => expect(resolveRef(refs, "refs/heads/main")).toEqual({ kind: "commit", commit: A }));
  test("a full commit, advertised or not", () => {
    const d = "d".repeat(40);
    expect(resolveRef(refs, d.toUpperCase())).toEqual({ kind: "commit", commit: asCommit(d)! });
  });
  test("a prefix of one tip", () => expect(resolveRef(refs, "cccc")).toEqual({ kind: "commit", commit: C }));
  test("a prefix of no tip needs a clone", () => expect(resolveRef(refs, "01fa5df")).toEqual({ kind: "abbreviated", prefix: "01fa5df" }));
  test("a name that is nothing", () => expect(resolveRef(refs, "nope")).toEqual({ kind: "missing" }));
});
