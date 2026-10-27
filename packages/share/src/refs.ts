// `git ls-remote` over git's smart HTTP protocol, with fetch: which commit a branch, tag or HEAD
// points at, without starting a sandbox. Most requests stop here, at a page R2 already has.
//
// The server answers GET <repo>/info/refs?service=git-upload-pack with pkt-lines:
//   001e# service=git-upload-pack\n 0000
//   <len><sha> HEAD\0<capabilities>\n
//   <len><sha> refs/heads/main\n
//   <len><sha> refs/tags/v1\n  <len><sha> refs/tags/v1^{}\n   (an annotated tag, then its commit)
//   0000
// https://git-scm.com/docs/http-protocol#_smart_clients

/** A full commit id: 40 hex digits (SHA-1) or 64 (SHA-256), lowercase. */
export type Commit = string & { readonly __commit: unique symbol };

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ABBREVIATED = /^[0-9a-f]{4,63}$/;

export function asCommit(value: string): Commit | null {
  return FULL_COMMIT.test(value) ? (value as Commit) : null;
}

/** What a remote advertises: its refs, and the URL that answered (with or without `.git`). */
export interface Remote {
  readonly url: string;
  readonly refs: ReadonlyMap<string, Commit>;
}

export type RemoteLookup = { ok: true; remote: Remote } | { ok: false; reason: string };

/** The refs of the repository at `url`, trying `<url>.git` too, as some hosts only answer that. */
export async function lsRemote(url: string, fetcher: typeof fetch = fetch): Promise<RemoteLookup> {
  let reason = "";
  for (const candidate of [url, `${url}.git`]) {
    const response = await fetcher(`${candidate}/info/refs?service=git-upload-pack`, {
      headers: { "user-agent": "git/2.47.0 (feynman-share)", accept: "application/x-git-upload-pack-advertisement" },
      redirect: "follow",
    });
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && type.startsWith("application/x-git-upload-pack-advertisement")) {
      const refs = parseAdvertisement(new Uint8Array(await response.arrayBuffer()));
      return refs ? { ok: true, remote: { url: candidate, refs } } : { ok: false, reason: `${candidate} sent refs git cannot read` };
    }
    await response.body?.cancel();
    // 401 and 403 are how GitHub and GitLab answer for private or missing repositories.
    reason = `${candidate} is not a public git repository (HTTP ${response.status})`;
  }
  return { ok: false, reason };
}

/** The refs in a smart HTTP advertisement, or null if it is not one. */
export function parseAdvertisement(body: Uint8Array): Map<string, Commit> | null {
  const text = new TextDecoder().decode(body);
  const refs = new Map<string, Commit>();
  let at = 0;
  let sawService = false;
  while (at + 4 <= text.length) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length)) return null;
    if (length === 0) {
      at += 4;
      continue;
    }
    if (length < 4 || at + length > text.length) return null;
    const line = text.slice(at + 4, at + length).replace(/\n$/, "");
    at += length;
    if (line.startsWith("# service=")) {
      sawService = true;
      continue;
    }
    const [sha = "", name = ""] = line.split("\0")[0].split(" ");
    const commit = asCommit(sha);
    // An empty repository advertises "0000…0000 capabilities^{}".
    if (commit && name && !/^0+$/.test(commit)) refs.set(name, commit);
  }
  return sawService ? refs : null;
}

/** What `?ref=` names in a remote. */
export type Resolution =
  | { kind: "commit"; commit: Commit }
  /** Hex too short to be a commit and matching no ref: only a clone can say which commit it is. */
  | { kind: "abbreviated"; prefix: string }
  | { kind: "missing" };

/** A branch, tag, ref or HEAD (when `ref` is empty) to its commit, the way `git checkout <ref>` reads it. */
export function resolveRef(refs: ReadonlyMap<string, Commit>, ref: string | null): Resolution {
  const wanted = ref?.trim() || "HEAD";
  const full = asCommit(wanted.toLowerCase());
  if (full) return { kind: "commit", commit: full };
  // A tag's ^{} entry is the commit an annotated tag points at; the plain entry is the tag object.
  const candidates =
    wanted === "HEAD"
      ? ["HEAD"]
      : wanted.startsWith("refs/")
        ? [`${wanted}^{}`, wanted]
        : [`refs/heads/${wanted}`, `refs/tags/${wanted}^{}`, `refs/tags/${wanted}`];
  for (const name of candidates) {
    const commit = refs.get(name);
    if (commit) return { kind: "commit", commit };
  }
  const prefix = wanted.toLowerCase();
  if (!ABBREVIATED.test(prefix)) return { kind: "missing" };
  // An abbreviation of an advertised tip needs no clone.
  const tips = new Set([...refs.values()].filter((commit) => commit.startsWith(prefix)));
  if (tips.size === 1) return { kind: "commit", commit: [...tips][0] };
  return { kind: "abbreviated", prefix };
}
