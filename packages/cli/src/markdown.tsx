// markdown.tsx — tiny 80/20 Markdown renderer for assistant replies.
// Covers only what a terminal coding agent actually receives: headings (#/##/###),
// bold, italic, inline code, fenced code blocks, bullet/numbered lists, links and
// paragraphs. Built purely on @opentui/react primitives (text/span/b/em/box) so
// there is no parser dependency and no async syntax-highlight pass — fenced code
// keeps its whitespace byte-for-byte and long lines are clipped by wrapMode="none".
// Anything not recognized is shown verbatim (never silently dropped).
import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";

/** Color subset the renderer needs; the UI passes its own palette. */
export type MdPalette = {
    text: string;
    blue: string;
    teal: string;
    peach: string;
    surface1: string;
    surface2: string;
};

// ── inline tokens ───────────────────────────────────────────────────────
type Inline =
    | { t: "text"; v: string }
    | { t: "code"; v: string }
    | { t: "bold"; c: Inline[] }
    | { t: "italic"; c: Inline[] }
    | { t: "link"; label: string; href: string };

const MARKER = /`|\*\*|\*|\[/;

function parseInline(src: string): Inline[] {
    const out: Inline[] = [];
    let rest = src;
    while (rest.length > 0) {
        const code = rest.match(/^`([^`]+)`/);
        if (code) {
            out.push({ t: "code", v: code[1]! });
            rest = rest.slice(code[0].length);
            continue;
        }
        const bold = rest.match(/^\*\*([^*]+)\*\*/);
        if (bold) {
            out.push({ t: "bold", c: parseInline(bold[1]!) });
            rest = rest.slice(bold[0].length);
            continue;
        }
        const italic = rest.match(/^\*([^*]+)\*/);
        if (italic) {
            out.push({ t: "italic", c: parseInline(italic[1]!) });
            rest = rest.slice(italic[0].length);
            continue;
        }
        const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
        if (link) {
            out.push({ t: "link", label: link[1]!, href: link[2]! });
            rest = rest.slice(link[0].length);
            continue;
        }
        // Plain text run up to the next marker (or end of input).
        const next = rest.search(MARKER);
        const text = next === -1 ? rest : rest.slice(0, next);
        if (text.length > 0) out.push({ t: "text", v: text });
        rest = rest.slice(text.length);
        if (next === 0) {
            // Lone marker character (unmatched `*`, `[`, backtick) — keep verbatim.
            out.push({ t: "text", v: rest.charAt(0) });
            rest = rest.slice(1);
        }
    }
    return out;
}

function inlineNodes(nodes: Inline[], palette: MdPalette, keyPrefix: string): ReactNode[] {
    return nodes.map((n, i) => {
        const key = `${keyPrefix}-${i}`;
        switch (n.t) {
            case "text":
                return n.v;
            case "code":
                return (
                    <span key={key} fg={palette.peach} bg={palette.surface2}>
                        {n.v}
                    </span>
                );
            case "bold":
                return <b key={key}>{inlineNodes(n.c, palette, key)}</b>;
            case "italic":
                return <em key={key}>{inlineNodes(n.c, palette, key)}</em>;
            case "link":
                return (
                    <span key={key} fg={palette.blue}>
                        {n.label} ({n.href})
                    </span>
                );
        }
    });
}

// ── block parsing ───────────────────────────────────────────────────────
type Block =
    | { t: "heading"; level: number; line: string }
    | { t: "paragraph"; lines: string[] }
    | { t: "code"; lines: string[] }
    | { t: "list"; ordered: boolean; start: number; items: string[] };

const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const NUMBERED_RE = /^\s*(\d+)\.\s+(.*)$/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const FENCE_RE = /^```\w*\s*$/;
const BLOCK_START = /^(#{1,3})\s|^```|^\s*[-*+]\s|^\s*\d+\.\s/;

function parseBlocks(md: string): Block[] {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const blocks: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;
        if (FENCE_RE.test(line)) {
            const code: string[] = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
            i++; // skip the closing fence (or run off the end — tolerate an unclosed fence)
            blocks.push({ t: "code", lines: code });
            continue;
        }
        const heading = line.match(HEADING_RE);
        if (heading) {
            blocks.push({ t: "heading", level: heading[1]!.length, line: heading[2]! });
            i++;
            continue;
        }
        const bullet = line.match(BULLET_RE);
        if (bullet) {
            const items = [bullet[1]!];
            i++;
            while (i < lines.length) {
                const m = lines[i]!.match(BULLET_RE);
                if (!m) break;
                items.push(m[1]!);
                i++;
            }
            blocks.push({ t: "list", ordered: false, start: 0, items });
            continue;
        }
        const numbered = line.match(NUMBERED_RE);
        if (numbered) {
            const start = Number(numbered[1]!);
            const items = [numbered[2]!];
            i++;
            while (i < lines.length) {
                const m = lines[i]!.match(NUMBERED_RE);
                if (!m) break;
                items.push(m[2]!);
                i++;
            }
            blocks.push({ t: "list", ordered: true, start, items });
            continue;
        }
        if (line.trim().length === 0) {
            i++;
            continue;
        }
        // Paragraph: keep accumulating while the line is non-blank and not the
        // start of another block type. Lines join with a single space (markdown
        // soft-break behavior) so prose flows and wraps naturally.
        const para = [line];
        i++;
        while (i < lines.length && lines[i]!.trim().length > 0 && !BLOCK_START.test(lines[i]!)) {
            para.push(lines[i]!);
            i++;
        }
        blocks.push({ t: "paragraph", lines: para });
    }
    return blocks;
}

// ── rendering ───────────────────────────────────────────────────────────
function BlockView({ block, palette }: { block: Block; palette: MdPalette }) {
    switch (block.t) {
        case "heading": {
            const fg = block.level === 1 ? palette.blue : block.level === 2 ? palette.teal : palette.peach;
            return (
                <text fg={fg} attributes={TextAttributes.BOLD} wrapMode="word">
                    {inlineNodes(parseInline(block.line), palette, "h")}
                </text>
            );
        }
        case "paragraph":
            return (
                <text fg={palette.text} wrapMode="word">
                    {inlineNodes(parseInline(block.lines.join(" ")), palette, "p")}
                </text>
            );
        case "code":
            // Fenced code: a distinct block, whitespace preserved, no wrapping —
            // long lines are clipped at the container edge instead of breaking layout.
            // Tabs become spaces (terminals render tab stops unpredictably inside a
            // fixed-width text buffer, which would misalign indented code).
            return (
                <box backgroundColor={palette.surface1} paddingX={2} paddingY={1} flexDirection="column">
                    {block.lines.map((l, i) => (
                        <text key={i} fg={palette.text} wrapMode="none">
                            {l.replace(/\t/g, "    ")}
                        </text>
                    ))}
                </box>
            );
        case "list":
            return (
                <box flexDirection="column">
                    {block.items.map((item, i) => (
                        <box key={i} flexDirection="row" gap={1}>
                            <text fg={palette.teal}>{block.ordered ? `${block.start + i}.` : "•"}</text>
                            <text fg={palette.text} wrapMode="word">
                                {inlineNodes(parseInline(item), palette, `l${i}`)}
                            </text>
                        </box>
                    ))}
                </box>
            );
    }
}

/** Renders an assistant Markdown reply. Unknown syntax stays visible as text. */
export function MarkdownContent({ content, palette }: { content: string; palette: MdPalette }) {
    const blocks = parseBlocks(content);
    return (
        <box flexDirection="column" gap={1}>
            {blocks.map((block, i) => (
                <BlockView key={i} block={block} palette={palette} />
            ))}
        </box>
    );
}
