# PRODUCT.md — Aloud (local Speechify clone)

> Scope note: this file covers the text-to-speech reader app being built in `aloud/`.
> The momentum-scanner files elsewhere in this repo are a separate, pre-existing project.

## What it is

A personal text-to-speech reader the owner installs on their phone as a PWA and uses
entirely locally. Paste or type any text — an article, notes, an email — and the phone's
own built-in voices read it aloud while the words light up in sync so you can follow
along or look away.

## Unique mechanism

Turns any text on the phone into follow-along audio: word-by-word highlighting driven by
the speech engine's boundary events, with adjustable speed, voice, and pitch. Everything
runs on-device via the Web Speech API — no server, no account, no upload, works offline
once installed.

## Audience & scene

One person (the repo owner) on their phone: commuting, walking, doing chores, resting
their eyes. One-handed use, small screen, often bright daylight or a dark room. They open
the app, drop text in, hit play, and mostly *listen* — glancing at the screen to check
where the voice is.

## Core tasks (Operate)

1. Add text: paste, type, or import a .txt file.
2. Listen: play/pause, skip back/forward by sentence, scrub progress.
3. Tune: speed (0.5×–3×), voice picker (device voices), pitch.
4. Keep: a small local library of saved documents (localStorage), resume position.

## Constraints

- Single self-contained static app: one HTML file plus manifest + service worker. No build
  step, no dependencies, no network calls at runtime.
- Voices are whatever the device provides (iOS Safari / Android Chrome); word-boundary
  events are unavailable on some engines, so highlighting must degrade to sentence-level
  gracefully.
- Installable PWA; must work offline after first load.

## Brand commitments

None inherited. Name: **Aloud**. No claims beyond what the app actually does; no fake
stats, no testimonials, no pricing — this is a personal tool, not a marketed product.
