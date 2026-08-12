// theme.ts — the single source of truth for NightCode's terminal look.
//
// Every UI module imports from here instead of re-declaring its own hex codes,
// so a palette tweak lands everywhere at once. The scale is deliberately small:
// four neutrals (bg → text), one accent pair for brand/interaction, and four
// semantic colors. Anything that needs "a bit different" should reach for an
// existing token rather than inventing a new shade — that is what keeps a
// terminal UI feeling like one designed surface instead of a pile of widgets.

export const C = {
    /** Page background. Slightly blue-black so it reads as "deep" next to pure-black terminals. */
    bg: "#0A0A0F",
    /** Raised surfaces: the input box, dropdown menus. */
    panel: "#111119",
    /** Recessed surfaces: fenced code, inline code chips. */
    panelAlt: "#17171F",
    /** Hairlines: borders, dividers, rails. Never used for text. */
    line: "#24242F",

    /** Barely-there text: separators, timestamps, decorative marks. */
    faint: "#3E3E4E",
    /** Secondary text: metadata, hints, tool output previews. */
    muted: "#7A7A8E",
    /** Body text. */
    text: "#D2D8E8",
    /** Emphasis text: headings, the focused row. */
    bright: "#EDF0F7",

    /** Primary accent — brand, prompts, focus. */
    accent: "#8AB4FA",
    /** Secondary accent — the assistant's voice, the spinner. */
    accent2: "#C4A7F7",

    success: "#A6E3A1",
    warn: "#F9E2AF",
    danger: "#F38BA8",
    peach: "#FAB387",
    teal: "#94E2D5",

    /** Foreground for text sitting ON an accent fill (selected rows). */
    onAccent: "#0A0A0F",
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
