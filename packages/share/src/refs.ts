// `git ls-remote` over git's smart HTTP protocol, with fetch: which commit a branch, tag or HEAD
// points at, without starting a sandbox. Most requests stop here, at a page R2 already has.
//
// Protocol v2 first: POST <repo>/git-upload-pack with `command=ls-refs` and ref prefixes, so the
// host sends HEAD, branches and tags only. A popular GitHub repository also has a ref per pull
// request, megabytes of them, which the v0 listing below always includes.
// https://git-scm.com/docs/protocol-v2#_ls_refs
//
// Then v0, for hosts without v2: GET <repo>/info/refs?service=git-upload-pack answers pkt-lines:
//   001e# service=git-upload-pack\n 0000
//   <len><sha> HEAD\0<capabilities>\n
//   <len><sha> refs/heads/main\n
//   <len><sha> refs/tags/v1\n  <len><sha> refs/tags/v1^{}\n   (an annotated tag, then its commit)
//   0000
// https://git-scm.com/docs/http-protocol#_smart_clients

/** A full commit id: 40 hex digits (SHA-1) or 64 (SHA-256), lowercase. */
export type Commit = string & { readonly __commit: unique symbol };

const USER_AGENT = "git/2.47.0 (feynman-share)";
const FLUSH = "0000";

/** The most of a ref advertisement read: a repository with more refs than fit is turned away. */
export const MAX_ADVERTISEMENT_BYTES = 4 * 1024 * 1024;

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
  const candidates = [url, `${url}.git`];
  for (const candidate of candidates) {
    const refs = await lsRefs(candidate, fetcher);
    if (refs) return { ok: true, remote: { url: candidate, refs } };
  }
  return advertisedRefs(candidates, fetcher);
}

const LS_REFS = [
  pktLine("command=ls-refs\n"),
  "0001",
  pktLine("peel\n"),
  pktLine("ref-prefix HEAD\n"),
  pktLine("ref-prefix refs/heads/\n"),
  pktLine("ref-prefix refs/tags/\n"),
  "0000",
].join("");

/** HEAD, branches and tags over protocol v2, or null when the host does not answer it. */
async function lsRefs(url: string, fetcher: typeof fetch): Promise<Map<string, Commit> | null> {
  const response = await fetcher(`${url}/git-upload-pack`, {
    method: "POST",
    body: LS_REFS,
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "git-protocol": "version=2",
    },
    redirect: "follow",
  });
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.startsWith("application/x-git-upload-pack-result")) {
    await response.body?.cancel();
    return null;
  }
  const body = await readAtMost(response, MAX_ADVERTISEMENT_BYTES);
  return body ? parseLsRefs(body) : null;
}

/** The refs in an ls-refs answer, or null if it is not one (a host without v2 can answer empty). */
export function parseLsRefs(body: Uint8Array): Map<string, Commit> | null {
  const lines = pktLines(new TextDecoder().decode(body));
  if (!lines || lines[lines.length - 1] !== FLUSH) return null;
  const refs = new Map<string, Commit>();
  for (const line of lines) {
    if (line === FLUSH) continue;
    if (line.startsWith("ERR ")) return null;
    const [sha = "", name = "", ...attributes] = line.split(" ");
    const commit = asCommit(sha);
    if (!commit || !name) return null;
    refs.set(name, commit);
    const peeled = asCommit(attributes.find((a) => a.startsWith("peeled:"))?.slice("peeled:".length) ?? "");
    if (peeled) refs.set(`${name}^{}`, peeled);
  }
  return refs;
}

/** Every ref, over protocol v0. */
async function advertisedRefs(candidates: string[], fetcher: typeof fetch): Promise<RemoteLookup> {
  let reason = "";
  for (const candidate of candidates) {
    const response = await fetcher(`${candidate}/info/refs?service=git-upload-pack`, {
      headers: { "user-agent": USER_AGENT, accept: "application/x-git-upload-pack-advertisement" },
      redirect: "follow",
    });
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && type.startsWith("application/x-git-upload-pack-advertisement")) {
      const body = await readAtMost(response, MAX_ADVERTISEMENT_BYTES);
      if (!body) return { ok: false, reason: `${candidate} has more branches and tags than this service reads` };
      const refs = parseAdvertisement(body);
      return refs ? { ok: true, remote: { url: candidate, refs } } : { ok: false, reason: `${candidate} sent refs git cannot read` };
    }
    await response.body?.cancel();
    // 401 and 403 are how GitHub and GitLab answer for private or missing repositories.
    reason = `${candidate} is not a public git repository (HTTP ${response.status})`;
  }
  return { ok: false, reason };
}

/** The body, or null once it passes `limit` bytes (and the rest is not read). */
async function readAtMost(response: Response, limit: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The refs in a v0 advertisement, or null if it is not one. */
export function parseAdvertisement(body: Uint8Array): Map<string, Commit> | null {
  const lines = pktLines(new TextDecoder().decode(body));
  if (!lines || !lines[0]?.startsWith("# service=")) return null;
  const refs = new Map<string, Commit>();
  for (const line of lines.slice(1)) {
    if (line === FLUSH) continue;
    const [sha = "", name = ""] = line.split("\0")[0].split(" ");
    const commit = asCommit(sha);
    // An empty repository advertises "0000…0000 capabilities^{}".
    if (commit && name && !/^0+$/.test(commit)) refs.set(name, commit);
  }
  return refs;
}

/** pkt-lines without their trailing newline, a flush as FLUSH; null if the text is not pkt-lines. */
function pktLines(text: string): string[] | null {
  const lines: string[] = [];
  let at = 0;
  while (at < text.length) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length) || at + 4 > text.length) return null;
    if (length <= 2) {
      // 0000 flush, 0001 delimiter, 0002 response end.
      lines.push(length === 0 ? FLUSH : "");
      at += 4;
      continue;
    }
    if (length < 4 || at + length > text.length) return null;
    lines.push(text.slice(at + 4, at + length).replace(/\n$/, ""));
    at += length;
  }
  return lines.length ? lines : null;
}

function pktLine(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
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
