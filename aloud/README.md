# Aloud — your local Speechify

A pocket text-to-speech reader styled as a sport walkman. Paste any text, press **PLAY**,
and your phone reads it aloud while the words light up in sync. Everything runs on your
device with the phone's built-in voices — no server, no account, no upload, and it works
offline once installed.

## Get it on your phone

The app is plain static files, so any HTTPS host works. The easiest path is GitHub Pages:

1. Merge this branch (or push it to `main`).
2. On GitHub: **Settings → Pages → Source: Deploy from a branch**, pick the branch and
   `/ (root)` folder, save.
3. After it publishes, open
   `https://<your-username>.github.io/Momentum-scanner/aloud/` on your phone.
4. Install it:
   - **iPhone (Safari):** Share button → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** (or the install prompt).

After the first load it's cached by a service worker and runs fully offline.

> Quick test without Pages: from the repo folder run `npx serve .` and open
> `http://localhost:3000/aloud/` in a desktop browser. (Phones need HTTPS for the
> offline install, which is why Pages is the recommended route.)

## Using it

- **NEW** — make a tape: paste or type text, or load a `.txt`/`.md` file. On Android you
  can also share text straight to Aloud from other apps once it's installed.
- **PLAY / PAUSE** — start and stop the voice. The lit word follows the voice
  (karaoke-style) where the device's speech engine supports word events; otherwise the
  current sentence stays lit.
- **REW / FF** — skip back and forward one sentence. Tap any word on screen to jump there.
- **Speed fader** — 0.5× to 3×.
- **VOICE & TEXT door** — pick any voice installed on your device, tune pitch, and
  resize the reading text.
- **TAPES** — your library. Every tape remembers where you stopped. Stored in the
  browser's local storage, so it never leaves the device.

## Good to know

- Voices are whatever your phone provides. You can add more in the OS settings
  (iOS: Settings → Accessibility → Spoken Content → Voices; Android: Settings →
  Accessibility → Text-to-speech output).
- iOS pauses speech when the screen locks — the app keeps the screen awake while
  playing to soften this, but background playback is an OS limitation of the
  Web Speech API.
- Word-by-word highlighting depends on the speech engine reporting word boundaries;
  some Android voices don't, and the app automatically falls back to
  sentence highlighting.
