// markdown.check.tsx — assert-based self-check for assistant Markdown rendering.
// Renders the real MessageBubble (via the framework's headless test renderer) and
// verifies: headings/bold/inline code/fences render without raw markdown syntax,
// fenced code keeps its indentation, lists get real markers, long prose wraps,
// and long code lines never break the terminal layout (clipped, not wrapped).
// Run with: bun packages/cli/src/markdown.check.tsx
import assert from "node:assert/strict";
import { testRender } from "@opentui/react/test-utils";
import { MessageBubble } from "./index";

const SAMPLE = [
    "# Authentication",
    "",
    "The issue is in **auth.ts**.",
    "",
    "Run `npm test` before committing.",
    "",
    "```ts",
    "const token = getToken();",
    "if (!token) {",
    "    return unauthorized();",
    "}",
    "```",
    "",
    "Changes:",
    "- Fixed authentication",
    "- Added validation",
    "",
    "Steps:",
    "1. Inspect the file",
    "2. Modify the code",
    "3. Run the tests",
].join("\n");

async function render(msg: { role: "user" | "assistant"; content: string }, width: number, height: number) {
    const setup = await testRender(
        <box width="100%" flexDirection="column">
            <MessageBubble msg={{ id: "m", role: msg.role, content: msg.content }} />
        </box>,
        { width, height }
    );
    await setup.waitForVisualIdle();
    return setup.captureCharFrame();
}

async function main() {
    // ── full assistant bubble at a normal width ─────────────────────────
    const frame = await render({ role: "assistant", content: SAMPLE }, 80, 60);

    // raw markdown syntax must not survive
    assert.ok(!frame.includes("**"), "bold markers concealed");
    assert.ok(!frame.includes("```"), "fence markers concealed");
    assert.ok(!frame.includes("`npm test`"), "inline-code backticks concealed");
    assert.ok(!frame.includes("# Authentication"), "heading marker concealed");
    assert.ok(!frame.includes("- Fixed authentication"), "bullet marker concealed");

    // content + structure render
    assert.ok(frame.includes("Authentication"), "heading text rendered");
    assert.ok(frame.includes("auth.ts"), "bold text rendered");
    assert.ok(frame.includes("npm test"), "inline code rendered");
    assert.ok(frame.includes("return unauthorized();"), "code block content rendered");
    assert.ok(frame.includes("• Fixed authentication"), "bullet list renders with a real marker");
    assert.ok(frame.includes("• Added validation"), "second bullet present");
    assert.ok(frame.includes("1. Inspect the file"), "numbered list keeps its numbering");
    assert.ok(frame.includes("2. Modify the code"), "second numbered item present");

    // code indentation preserved exactly (4 spaces)
    assert.ok(frame.includes("    return unauthorized();"), "code indentation preserved");

    // ── inline constructs inside headings and list items ────────────────
    const inlineFrame = await render(
        {
            role: "assistant",
            content: ["# Fix **auth** now", "", "- Run `npm test`", "- Check `git status`"].join("\n"),
        },
        60,
        15
    );
    assert.ok(inlineFrame.includes("Fix auth now"), "heading with bold renders (marker dropped, text kept)");
    assert.ok(inlineFrame.includes("• Run npm test"), "list item with inline code renders");

    // ── user messages stay plain (no markdown interpretation) ───────────
    const userFrame = await render({ role: "user", content: "run **npm test** now" }, 80, 10);
    assert.ok(userFrame.includes("run **npm test** now"), "user input shown verbatim");

    // ── deep code indentation survives at a comfortable width ──────────
    const wideFrame = await render(
        {
            role: "assistant",
            content: ["```py", "def hello():", "    if True:", "        print(\"hello\")", "\tindented-by-tab", "```"].join("\n"),
        },
        60,
        15
    );
    assert.ok(wideFrame.includes("        print(\"hello\")"), "nested python indentation preserved exactly");
    assert.ok(wideFrame.includes("    indented-by-tab"), "tabs inside code become spaces");

    // ── narrow terminal: prose wraps, long code lines stay bounded ──────
    const longCode = "const longLine = \"" + "x".repeat(90) + "\";";
    const narrowFrame = await render(
        {
            role: "assistant",
            content: [
                "A paragraph that is intentionally long enough to wrap across several lines on a narrow terminal so it stays readable.",
                "",
                "```py",
                "def hello():",
                "    if True:",
                "        print(\"hello\")",
                longCode,
                "```",
            ].join("\n"),
        },
        36,
        30
    );

    const lines = narrowFrame.split("\n");
    for (const [i, line] of lines.entries()) {
        assert.ok(
            line.length <= 36,
            `line ${i} must not exceed terminal width (${line.length} > 36): ${JSON.stringify(line)}`
        );
    }
    // 4-space indent still visible inside the narrow bubble
    assert.ok(narrowFrame.includes("    if True:"), "code indentation survives the narrow render");

    // the long code line is present but clipped to the terminal, not wrapped
    assert.ok(narrowFrame.includes("const longLine"), "long code line rendered (clipped, not wrapped)");
    assert.ok(
        !narrowFrame.split("\n").some((l) => l.includes("const longLine") && l.includes("x".repeat(90))),
        "long code line must be clipped, not wrapped across rows"
    );

    // long prose actually wrapped onto multiple rows. Asserted as "the tail landed
    // on a LATER row than the head" rather than by matching a fixed pair of
    // fragments — which words share a row depends on the exact content width, so
    // fragment matching would break on any change to the transcript's gutters.
    const narrowRows = narrowFrame.split("\n");
    const headRow = narrowRows.findIndex((l) => l.includes("A paragraph that is"));
    const tailRow = narrowRows.findIndex((l) => l.includes("readable."));
    assert.ok(headRow >= 0, "long paragraph rendered");
    assert.ok(tailRow > headRow, "long paragraph wrapped across multiple rows");

    console.log("PASS — assistant markdown renders cleanly (headings, bold, code, lists, wrapping).");
    process.exit(0);
}

main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
});
