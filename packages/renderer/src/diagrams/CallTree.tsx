import { CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { CallNode } from "../model";
import { usePreference } from "../router";
import { AnchorLink } from "../ui";

/**
 * A step's measured call tree: the entry function, then the calls it makes, at
 * their call sites. Calls into the repository open into their own calls; calls to
 * libraries, the runtime, or the system (external) are leaves, hidden until asked for.
 */
export function CallTree({ root }: { root: CallNode }) {
  const [showExternal, setShowExternal] = usePreference<"hide" | "show">("externalCalls", "hide");
  const external = countExternal(root);
  return (
    <div className="flex flex-col gap-2">
      <ul className="font-mono text-[13px] leading-6">
        <Call node={root} depth={0} showExternal={showExternal === "show"} />
      </ul>
      {external > 0 && (
        <button
          type="button"
          className="self-start text-xs text-kumo-subtle hover:text-kumo-link hover:underline"
          onClick={() => setShowExternal(showExternal === "show" ? "hide" : "show")}
        >
          {showExternal === "show" ? "Hide" : "Show"} {external} library and system call{external === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

function Call({ node, depth, showExternal }: { node: CallNode; depth: number; showExternal: boolean }) {
  const children = node.children.filter((child) => showExternal || !child.external);
  const [open, setOpen] = useState(depth < 2);
  const at = node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : null;
  return (
    <li>
      <div className="flex items-baseline gap-1.5">
        {children.length ? (
          <button type="button" aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)} className="text-kumo-subtle hover:text-kumo-default">
            <CaretRightIcon size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="inline-block w-[11px]" />
        )}
        <span className={node.external ? "text-kumo-subtle" : "text-kumo-default"}>{node.label}</span>
        {at && (
          <span className="truncate text-xs text-kumo-subtle">
            <AnchorLink anchor={at} />
          </span>
        )}
      </div>
      {open && children.length > 0 && (
        <ul className="ml-[5px] border-l border-kumo-hairline pl-3">
          {children.map((child, i) => (
            <Call key={`${child.label}-${i}`} node={child} depth={depth + 1} showExternal={showExternal} />
          ))}
        </ul>
      )}
    </li>
  );
}

function countExternal(node: CallNode): number {
  return node.children.reduce((n, child) => n + (child.external ? 1 : 0) + countExternal(child), 0);
}
