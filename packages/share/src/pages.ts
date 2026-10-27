// Built pages in R2, one per repository and commit, and the pages shown when there is none.
import type { Commit } from "./refs.ts";
import type { Repository } from "./repository.ts";

/** `pages/github.com/leostera/feynman/<commit>.html`: a commit's page never changes. */
export function pageKey(repository: Repository, commit: Commit): string {
  return `pages/${repository.id}/${commit}.html`;
}

export async function putPage(bucket: R2Bucket, repository: Repository, commit: Commit, page: ArrayBuffer): Promise<void> {
  await bucket.put(pageKey(repository, commit), page, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { repository: repository.id, commit, builtAt: new Date().toISOString() },
  });
}

/** A stored page as the response to a share URL. */
export function pageResponse(object: R2ObjectBody, commit: Commit, options: { immutable: boolean; head: boolean }): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-feynman-commit", commit);
  // A branch moves, so its page is the latest commit's for a minute; a commit's page is forever.
  headers.set("cache-control", options.immutable ? "public, max-age=31536000, immutable" : "public, max-age=60");
  return new Response(options.head ? null : object.body, { headers });
}

export function errorPage(status: number, title: string, detail = "", log = ""): Response {
  const body = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Feynman</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 4rem auto; padding: 0 1.5rem; color: #1f2328; }
  pre { background: #f6f8fa; padding: 1rem; overflow: auto; font-size: 13px; border-radius: 6px; }
  code { font-size: 0.9em; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } pre { background: #161b22; } }
</style>
<h1>${escape(title)}</h1>
${detail ? `<p>${escape(detail)}</p>` : ""}
${log ? `<pre>${escape(log)}</pre>` : ""}
<p><a href="https://feynman.leostera.dev">Feynman</a> serves the explorer of any public repository at
<code>/s/&lt;host&gt;/&lt;path&gt;?ref=&lt;branch, tag or commit&gt;</code>.</p>
</html>
`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
