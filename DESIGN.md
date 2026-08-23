---
name: Aloud
description: A pocket text-to-speech reader played as a sport-walkman tape machine
colors:
  chassis-yellow: "#FFC907"
  chassis-yellow-hi: "#FFD84D"
  chassis-yellow-lo: "#EBAF00"
  chassis-yellow-deep: "#C79400"
  bezel-brass: "#B98F00"
  ink: "#161409"
  smoke: "#1B1A15"
  smoke-deep: "#12110D"
  label-paper: "#F4EFDF"
  key-charcoal: "#26241D"
  key-charcoal-hi: "#3A372C"
  reader-dim: "#A29A82"
  reader-live: "#F7F3E6"
  reader-done: "#8F8770"
  lamp-red: "#E23B22"
  lcd-amber: "#E8DFA9"
  tape-brown: "#4A3826"
  table-ground: "#232019"
typography:
  micro-caps:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "6.5px"
    fontWeight: 400
    letterSpacing: "0.2em"
  brand:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    letterSpacing: "0.14em"
  hand-label:
    fontFamily: "Caveat, cursive"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.1
  reading:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "19px"
    lineHeight: 1.66
rounded:
  key: "8px"
  window: "16px"
  cassette: "9px"
  label: "4px"
  device: "26px"
spacing:
  chassis-gutter: "12px"
  window-pad: "22px"
  key-gap: "8px"
components:
  key-transport:
    backgroundColor: "{colors.key-charcoal}"
    textColor: "#EDE8D8"
    rounded: "{rounded.key}"
    padding: "10px 6px 8px"
  key-primary:
    backgroundColor: "{colors.chassis-yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "10px 6px 8px"
  label-sticker:
    backgroundColor: "{colors.label-paper}"
    textColor: "#242015"
    rounded: "{rounded.label}"
    padding: "2px 10px 3px"
  lcd-strip:
    backgroundColor: "#2E2B1E"
    textColor: "{colors.lcd-amber}"
    rounded: "7px"
    padding: "7px 12px"
---

> Scope: this file documents the visual system of the **Aloud** app in `aloud/`.
> The momentum-scanner app elsewhere in this repo is a separate project it does not govern.

## Overview

Aloud is styled as a **sport walkman**: the entire viewport is a molded
sport-yellow portable player. Documents are cassettes with handwritten labels;
playback runs on charcoal mechanical transport keys; the text being read scrolls
behind a smoke-glass window with the current word lit in chassis yellow
(karaoke-style). The world deliberately refuses the category default — a white
SaaS reader with a gradient play button. Every new surface must be a *part of
the machine* (a door, a window, a label, a key), never a floating card.

## Colors

Committed strategy: the yellow **is** the machine and owns every surface outside
the smoke window. The window is near-black warm smoke; everything inside it uses
the reader tones (`reader-dim` for waiting text, `reader-live` for the current
sentence, `reader-done` for finished text, yellow word-light for the spoken
word). Cream `label-paper` with a 2–3px `lamp-red` top stripe marks anything
that is "a label you wrote". `lamp-red` otherwise appears only as the RUN lamp.
On desktop widths the device sits on `table-ground`. Secondary text on yellow is
`rgba(22,20,9,.74)` ink, never gray.

## Typography

Three voices, role-pure:
- **Michroma** (embedded woff2, base64) — the machine's own print: brand mark,
  key labels, LCD, field labels. Always letterspaced caps, tiny sizes, embossed
  with `text-shadow: 0 1px 0 rgba(255,255,255,.3–.4)` on yellow.
- **Caveat 600** (embedded) — the owner's handwriting: tape titles, form input
  text. Never used for interface chrome.
- **Georgia** — the reading text inside the window; user-adjustable 14–26px.

Fonts are embedded as data URIs because the app must work fully offline; do not
introduce network-loaded faces.

## Layout

Single portrait column, `100dvh` flex: brand strip → smoke window (cassette
fixed on top, scrollable reader below) → deck (LCD, speed fader, five transport
keys, settings door). Max width 460px; wider viewports center the device on the
dark table with `border-radius: {rounded.device}` and a long soft drop shadow.
Safe-area insets pad the chassis. Corner screws mark the four chassis corners.

## Elevation & Depth

Depth is molded plastic, not flat design: every raised element carries an
offset+blur shadow plus an inset top highlight
(`inset 0 1px 0 rgba(255,255,255,.2–.5)`); recessed elements (window, LCD,
fader track) use inset shadows. Keys physically press: `translateY(2px)` with a
collapsed shadow on `:active`. The RUN lamp is the one permitted glow — it is a
literal LED (`box-shadow: 0 0 8px rgba(226,59,34,.9)` when lit).

## Shapes

Rounded-rectangle molding throughout; radii from the `rounded` scale. Icons are
authored inline SVG in tape-deck grammar (filled geometric transport glyphs,
consistent weight) — never emoji or unicode glyphs. Slider thumbs are ribbed
(repeating-linear-gradient grip lines); the settings door handle is a pair of
ribbed grips.

## Components

- **key-transport / key-primary** — mechanical keys: gradient face, 1px
  near-black border, glyph above a 6.5px Michroma label. Primary (yellow) keys
  are reserved for the single most-wanted action on a surface.
- **label-sticker** — cream paper with red top stripe and Caveat content; used
  on the deck cassette, tape-box items, and form fields (form fields add ruled
  lines via repeating-linear-gradient).
- **lcd-strip** — amber-on-dark status row with brass border; tabular numerals;
  transient messages appear here (uppercase, letterspaced), never as floating
  toasts.
- **Sheets** — bottom drawers in dark tray plastic (`#38342A→#2A2720`) with an
  18px top radius; backdrop `rgba(10,9,5,.55)`.
- **Reels** — SVG: cream hub with six charcoal teeth inside a `tape-brown`
  spool ring whose stroke-width transfers left→right with progress; rotation is
  rAF-driven with velocity easing, gated by `prefers-reduced-motion`.

## Do's and Don'ts

- Do express every state in the machine's vocabulary ("END OF SIDE A —
  REWOUND", a dashed ghost cassette for empty).
- Do keep word-highlight fallback honest: sentence-level lighting when the
  speech engine reports no word boundaries.
- Don't add floating cards, gradients-as-decoration, or a second accent color.
- Don't use Michroma for reading-length text or Caveat for controls.
- Don't introduce runtime network dependencies — everything ships in the file.
- Keep contrast floors: reading/dim text ≥4.5:1 on smoke; ink-soft ≥.74 alpha
  on yellow.
