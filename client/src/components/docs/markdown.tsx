// A safe Markdown subset for docs: headings, paragraphs, lists, bold/italic, code, tables, links.
// Everything is built as React elements from text nodes, so raw HTML shows as text and nothing
// is ever set as HTML. An image is shown as words and never fetched (a remote image tells its
// host who is reading). A link is only http or https (`safeUrl`) and shows its host.

import type { ReactNode } from "react";
import { safeUrl } from "../../document/docs";

const INLINE =
  /(!?)\[([^\]]*)\]\(([^)\s]*)\)|`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*/;
const MAX_DEPTH = 4;
const REDACTED = /<REDACTED:([^>]+)>/g;

/** Plain text, with a value the gate destroyed drawn as a block, as notes do. */
function words(t: string, key: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const m of t.matchAll(REDACTED)) {
    if (m.index > at) parts.push(t.slice(at, m.index));
    parts.push(
      <span key={`${key}-x${n++}`} className="config-drawer__block">
        {m[1]} · destroyed at the gate
      </span>,
    );
    at = m.index + m[0].length;
  }
  if (at < t.length) parts.push(t.slice(at));
  return parts;
}

function inline(
  s: string,
  key: string,
  links: boolean,
  depth = 0,
): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = s;
  let n = 0;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(...words(rest, `${key}-t${n++}`));
      break;
    }
    if (m.index > 0)
      out.push(...words(rest.slice(0, m.index), `${key}-p${n++}`));
    const k = `${key}-${n++}`;
    if (m[3] !== undefined) {
      const label = m[2] ?? "";
      const safe = safeUrl(m[3]);
      if (m[1] === "!") {
        out.push(
          <span key={k} className="doc-md__image">
            [image: {label || "no description"}, not loaded]
          </span>,
        );
      } else if (safe && links) {
        out.push(
          <a key={k} href={safe.href} target="_blank" rel="noopener noreferrer">
            {label || safe.host}
            <span className="doc-md__host"> ({safe.host})</span>
          </a>,
        );
      } else {
        out.push(label || m[3]);
      }
    } else if (m[4] !== undefined) {
      out.push(<code key={k}>{m[4]}</code>);
    } else if (m[5] !== undefined) {
      out.push(
        <strong key={k}>
          {depth < MAX_DEPTH ? inline(m[5], k, links, depth + 1) : m[5]}
        </strong>,
      );
    } else if (m[6] !== undefined) {
      out.push(
        <em key={k}>
          {depth < MAX_DEPTH ? inline(m[6], k, links, depth + 1) : m[6]}
        </em>,
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** The document body as React elements. */
export function Markdown({ source }: { source: string }): ReactNode {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  const isBlockStart = (l: string, next: string | undefined) =>
    l.trim() === "" ||
    l.trimStart().startsWith("```") ||
    HEADING.test(l) ||
    UL.test(l) ||
    OL.test(l) ||
    (l.includes("|") &&
      next !== undefined &&
      TABLE_RULE.test(next) &&
      next.includes("-"));

  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${b++}`;
    if (line.trim() === "") {
      i += 1;
    } else if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```"))
        code.push(lines[i++]!);
      i += 1;
      blocks.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (HEADING.test(line)) {
      const m = HEADING.exec(line)!;
      // The page title is the h1; a body heading starts at h2.
      const Tag = `h${Math.min(6, m[1]!.length + 1)}` as
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      blocks.push(<Tag key={key}>{inline(m[2]!, key, true)}</Tag>);
      i += 1;
    } else if (
      line.includes("|") &&
      lines[i + 1] !== undefined &&
      TABLE_RULE.test(lines[i + 1]!) &&
      lines[i + 1]!.includes("-")
    ) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i]!.includes("|") &&
        lines[i]!.trim() !== ""
      )
        rows.push(cells(lines[i++]!));
      blocks.push(
        <table key={key}>
          <thead>
            <tr>
              {head.map((c, ci) => (
                <th key={ci}>{inline(c, `${key}h${ci}`, true)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {head.map((_, ci) => (
                  <td key={ci}>
                    {inline(r[ci] ?? "", `${key}r${ri}c${ci}`, true)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
    } else if (UL.test(line) || OL.test(line)) {
      const ordered = !UL.test(line);
      const re = ordered ? OL : UL;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!))
        items.push(re.exec(lines[i++]!)![1]!);
      const li = items.map((t, ti) => (
        <li key={ti}>{inline(t, `${key}l${ti}`, true)}</li>
      ));
      blocks.push(ordered ? <ol key={key}>{li}</ol> : <ul key={key}>{li}</ul>);
    } else {
      const para: string[] = [line];
      i += 1;
      while (i < lines.length && !isBlockStart(lines[i]!, lines[i + 1]))
        para.push(lines[i++]!);
      blocks.push(<p key={key}>{inline(para.join("\n"), key, true)}</p>);
    }
  }
  return <div className="doc-md">{blocks}</div>;
}
