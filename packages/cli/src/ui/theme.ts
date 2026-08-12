// theme.ts — the single source of truth for NightCode's terminal look.
//
// Every UI module imports from here instead of re-declaring its own hex codes,
// so a palette tweak lands everywhere at once. The scale is deliberately small:
// four neutrals (bg → text), one accent pair for brand/interaction, and four
// semantic colors. Anything that needs "a bit different" should reach for an
// existing token rather than inventing a new shade — that is what keeps a
// terminal UI feeling like one designed surface instead of a pile of widgets.

// ── Ember Night ───────────────────────────────────────────────────────────────
// Warm accents on a cool violet-ink ground. The neutrals sit around hue 260 and
// the accents around hue 30, which is close to complementary — that opposition
// is what makes a single ember mark carry across a wall of dim text without
// needing bold, a fill, or a bigger glyph.
export const C = {
    /** Page background — ink, not black. Pure #000 kills the accents' glow. */
    bg: "#09080F",
    /** Raised surfaces: the input box, dropdown menus. */
    panel: "#0F0D18",
    /** Recessed surfaces: fenced code, inline code chips. */
    panelAlt: "#16121F",
    /** Hairlines: borders, dividers, rails. Never used for text. */
    line: "#241F33",

    /** Barely-there text: separators, background steps, decorative marks. */
    faint: "#4A4266",
    /** Secondary text: metadata, hints, tool output previews. */
    muted: "#948BB0",
    /** Body text. */
    text: "#E2DCF2",
    /** Emphasis text: headings, the focused row. */
    bright: "#FDFBFF",

    /** Primary accent — brand, the prompt caret, focus. */
    accent: "#FF7A2F",
    /** Secondary accent — the assistant's voice and the thinking spinner.
     *  Lighter than the primary on purpose: the answer is the brightest thing
     *  on screen, and everything else recedes behind it. */
    accent2: "#FFCE7A",

    success: "#3DDC97",
    warn: "#FF9F45",
    danger: "#FF4D6D",
    /** Inline code and the destructive-action frame. */
    peach: "#FFB870",
    /** The one cool accent — h3 headings. A counterpoint keeps the warm from
     *  flattening into a single orange wash. */
    teal: "#6BC5F0",

    /** Foreground for text sitting ON an accent fill (selected rows). */
    onAccent: "#09080F",
} as const;

/**
 * Glyphs. Kept in one place so the character set stays consistent (and so a
 * terminal with a thin font can be accommodated by editing a single table).
 */
export const G = {
    /** Leading mark for an assistant turn and for a finished tool call. */
    dot: "⏺",
    /** Result branch under a tool call — the "└" of the activity tree. */
    branch: "⎿",
    /** The user's echoed prompt. */
    quote: ">",
    /** The input caret. */
    caret: "›",
    /** Brand mark. */
    mark: "◈",
    spark: "✦",
    warn: "⚠",
    ok: "✓",
    fail: "✗",
    /** Status pip in the footer. */
    pip: "●",
    /** Model-menu selection marker. */
    pointer: "▸",
} as const;

/**
 * Spinner frames — a spark that grows and fades rather than a rotating bar, so a
 * long run looks like it is breathing instead of grinding.
 */
export const SPINNER = ["·", "✢", "✳", "∗", "✻", "✽"] as const;

/** Frame interval for {@link SPINNER}, in ms. */
export const SPINNER_MS = 300;

/**
 * Where the spinner starts. Frame 0 is a bare `·`, which is also the mark on a
 * background-step row — starting there makes a just-started run look like an
 * inert note for its first 300ms. Beginning mid-cycle makes it read as live
 * from the first painted frame.
 */
export const SPINNER_START = 2;
