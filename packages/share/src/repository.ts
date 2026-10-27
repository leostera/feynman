// What a /s/<host>/<path> route names: a public git repository served over HTTPS. Parsing it
// here, once, means the rest of the Worker, the R2 keys and the sandbox only ever see a host
// that is a DNS name and a path made of plain segments.

/** A public git repository, as named in a share URL. */
export interface Repository {
  /** Lowercase DNS name, such as `github.com`. Never an IP address or `localhost`. */
  readonly host: string;
  /** Path segments without a trailing `.git`, such as `leostera/feynman`. */
  readonly path: string;
  /** Where to fetch it from: `https://<host>/<path>`. */
  readonly url: string;
  /** `<host>/<path>`: names it in R2 keys and sandbox names. */
  readonly id: string;
}

export type RepositoryParse = { ok: true; repository: Repository } | { ok: false; reason: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const MAX_SEGMENTS = 20;

/** `github.com/leostera/feynman` (what follows /s/) → the repository it names. */
export function parseRepository(route: string): RepositoryParse {
  let decoded: string;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    return { ok: false, reason: "the repository path is not valid URL encoding" };
  }
  const [rawHost = "", ...segments] = decoded.replace(/\/+$/, "").split("/");
  const host = rawHost.toLowerCase();
  if (!isPublicHostname(host)) return { ok: false, reason: `${JSON.stringify(rawHost)} is not a public hostname` };
  if (segments.length === 0) return { ok: false, reason: "name a repository after the host, such as github.com/leostera/feynman" };
  if (segments.length > MAX_SEGMENTS) return { ok: false, reason: `a repository path has at most ${MAX_SEGMENTS} segments` };
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      return { ok: false, reason: `${JSON.stringify(segment)} is not a repository path segment` };
    }
  }
  const last = segments.length - 1;
  segments[last] = segments[last].replace(/\.git$/, "");
  if (!segments[last]) return { ok: false, reason: "the repository name is empty" };
  const path = segments.join("/");
  return { ok: true, repository: { host, path, url: `https://${host}/${path}`, id: `${host}/${path}` } };
}

/** A DNS name with a top-level domain that is not all digits, so never an IP address. */
function isPublicHostname(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  const tld = labels[labels.length - 1];
  return /[a-z]/.test(tld) && tld !== "localhost" && tld !== "local" && tld !== "internal";
}
