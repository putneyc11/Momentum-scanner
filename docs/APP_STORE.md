# Shipping Momentum Scanner to the App Store — step by step

Everything in the repo is done. What remains needs a Mac with Xcode, an Apple
Developer account ($99/yr), and about two hours the first time. Follow the
steps in order; each one says what "done" looks like.

**What the repo already contains**

- `native/` — Capacitor iOS shell config, 1024 icon + splash, privacy
  manifest, Info.plist patch script, App Store Connect copy and review notes.
- Server: APNs push over HTTP/2 (`/push/register { apns }`), `/auth/forget`
  account deletion, `/privacy` `/terms` `/support` pages, `/config.apns`.
- App: detects the native shell, hides simulated Apple/Google sign-in and the
  pretend Pro purchase, registers the APNs token when the bell is turned on,
  shows pushes received in the foreground as in-app banners, Delete account in
  Settings, legal links on sign-up and the About page.

The shell loads the live web app from Render, so after the first store
release every web deploy reaches iPhone users without a new review.

---

## Step 0 — Accounts (one-time, ~1 day for Apple approval)

1. Enroll at https://developer.apple.com/programs/enroll/ as an individual
   (or an LLC if you have one — the name shown in the store is the entity).
2. Install Xcode from the Mac App Store (16 or newer). Open it once and accept
   the license. Install Node 22: https://nodejs.org.
3. Sign in to Xcode with the Apple ID: Xcode → Settings → Accounts.

**Done when:** https://appstoreconnect.apple.com opens without an enrollment banner.

## Step 1 — Register the app identifier and the push key

1. https://developer.apple.com/account/resources/identifiers → **+** → App IDs
   → App → Bundle ID **Explicit** `com.momentumscanner.app`, description
   "Momentum Scanner". Under Capabilities tick **Push Notifications** and
   **Time Sensitive Notifications**. Continue → Register.
2. https://developer.apple.com/account/resources/authkeys → **+** → name
   "Momentum Scanner APNs", tick **Apple Push Notifications service (APNs)** →
   Continue → Register → **Download**. You get `AuthKey_XXXXXXXXXX.p8`.
   It downloads once; keep it somewhere safe.
3. Note three values: the **Key ID** (10 characters, shown on that page), your
   **Team ID** (Membership page, top right), and the bundle id.

**Done when:** you have the .p8 file, Key ID, Team ID.

## Step 2 — Put the push key on Render (never in the repo)

Render dashboard → momentum-scanner → Environment → add:

| Key | Value |
|---|---|
| `APNS_KEY_P8` | the contents of the .p8 file. Easiest: in Terminal `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy`, then paste. Raw PEM also works. |
| `APNS_KEY_ID` | the 10-character Key ID |
| `APNS_TEAM_ID` | your Team ID |
| `APNS_BUNDLE_ID` | `com.momentumscanner.app` |
| `APNS_SANDBOX` | `1` while testing from Xcode; **remove it** before TestFlight/App Store builds (they use production APNs). |
| `SUPPORT_EMAIL` | the address you want on the privacy/support pages |

Also confirm `VAPID_PRIVATE_JWK` / `VAPID_PUBLIC_RAW`, `INVITE_CODE` and the
Alpaca keys are set (see AGENT_HANDOFF §5). Save → Render redeploys.

**Done when:** `https://momentum-scanner.onrender.com/config` shows `"apns":true`
and the Render log prints `APNs configured → https://api.push.apple.com`.

## Step 3 — Generate the Xcode project (Mac, Terminal)

```bash
git clone https://github.com/putneyc11/Momentum-scanner.git
cd Momentum-scanner/native
# if your Render URL is not momentum-scanner.onrender.com, edit server.url in capacitor.config.json first
npm install
npx cap add ios            # creates native/ios/
bash scripts/ios-setup.sh  # Info.plist, privacy manifest, iPhone-only, portrait
npm run assets             # renders every icon + splash size from assets/
npx cap sync ios
npx cap open ios           # opens Xcode
```

If `npx cap add ios` complains about CocoaPods: `sudo gem install cocoapods`
(or `brew install cocoapods`) and re-run it.

**Done when:** Xcode opens the `App` workspace with no red errors.

## Step 4 — Configure signing and capabilities in Xcode

In the left tree click **App** (blue icon) → target **App**:

1. **Signing & Capabilities** → Team: pick yours → "Automatically manage
   signing". Bundle Identifier must read `com.momentumscanner.app`.
2. **+ Capability** → **Push Notifications**.
3. **+ Capability** → **Background Modes** → tick **Remote notifications**.
4. **+ Capability** → **Time Sensitive Notifications** (lets the alerts break
   through Focus modes; the server sends `interruption-level: time-sensitive`).
5. **General** → Version `2.0.0`, Build `1`. Deployment target iOS 15 or later.
   Under *Supported Destinations* remove iPad if present (iPhone only).
6. Check `PrivacyInfo.xcprivacy` is listed under App/App in the file tree. If
   not: File → Add Files to "App" → pick `native/ios/App/App/PrivacyInfo.xcprivacy`
   → make sure target App is ticked.

**Done when:** Product → Build (⌘B) succeeds.

## Step 5 — Run it on your iPhone

1. Plug the iPhone in, unlock it, trust the computer. Pick it as the run
   destination at the top of Xcode → **Run** (▶). First run: on the phone go to
   Settings → General → VPN & Device Management → trust your developer cert.
2. Walk the flow: walkthrough → Create account → email → Free → access code →
   watchlist loads. Turn the bell on → iOS asks for notification permission →
   allow. The banner should say "Lock-screen alerts armed".
3. Check the Render log: `push registered for device — devices with push: 1`.
4. Lock the phone and wait for a real alert during market hours, or test
   without the market: Xcode → Debug → Simulate… is not available for APNs on
   device, so use the server's own path: from a terminal
   `curl -X POST https://momentum-scanner.onrender.com/push/test` is **not** a
   route; instead temporarily set `LEGACY_PUSH=1` on Render during a live
   session so the first single trigger pushes, then remove it.

While running from Xcode the token is a **sandbox** token — `APNS_SANDBOX=1`
must be set on Render for these pushes to deliver. Remove it again in step 6.

**Done when:** a push lands on the lock screen from the Xcode build.

## Step 6 — Archive and upload to TestFlight

1. Remove `APNS_SANDBOX` from Render (TestFlight builds use production APNs).
2. In Xcode set the destination to **Any iOS Device (arm64)**.
3. Product → **Archive**. When the Organizer opens: **Distribute App** →
   **App Store Connect** → Upload → keep defaults → Upload.
4. https://appstoreconnect.apple.com → **My Apps** → **+** → New App:
   Platform iOS, Name **Momentum Scanner**, Language English (U.S.),
   Bundle ID `com.momentumscanner.app`, SKU `momentum-scanner-ios`, Full access.
5. The build appears under **TestFlight** after 10–30 min of processing.
   Answer the export-compliance question if asked: **No** (the Info.plist
   already declares no non-exempt encryption).
6. TestFlight → Internal Testing → **+** group "Me" → add your Apple ID →
   add the build. Install the TestFlight app on your iPhone and install it.
   Confirm the push still lands from the TestFlight build (production APNs).

**Done when:** the TestFlight build runs and pushes on your phone.

## Step 7 — Fill in App Store Connect

All text is ready in `native/store/metadata.md`. In App Store Connect → the
app → **1.0 Prepare for Submission**:

1. **Screenshots**: run the app in Simulator "iPhone 16 Pro Max" (it needs a
   network; the simulator loads the Render URL fine) and press ⌘S on the
   watchlist, Advanced view, Level 2, AI plan, alerts sheet, onboarding.
   Upload 3–10 under *iPhone 6.9" Display*. No iPad set (iPhone-only).
2. **Promotional text, Description, Keywords, Support URL, Marketing URL**
   — paste from metadata.md.
   Support URL `https://momentum-scanner.onrender.com/support`.
3. **App Information** (left sidebar): Category Finance, Content Rights (you
   own the rights), **Privacy Policy URL**
   `https://momentum-scanner.onrender.com/privacy`.
4. **Age Rating** → Edit → all "None" → 4+.
5. **App Privacy** → Get Started → answer with the "App Privacy" block in
   metadata.md (Email, Device ID, Other User Content; all App Functionality,
   linked to user, no tracking) → Publish.
6. **Pricing and Availability** → Free, all countries (or US only).
7. **Build** → **+** → pick the TestFlight build.
8. **App Review Information**: your contact details; **Sign-in required: Yes**
   with any email (say "any email address, no password"); in **Notes** paste the
   review-notes block from metadata.md and fill in the real `INVITE_CODE`
   value from Render. Reviewers test at odd hours — the note tells them the
   watchlist is empty outside 4 AM–8 PM ET and points them at Replay.
9. Version Release: **Manually release this version** (so you control the day).

**Done when:** the Submit for Review button is enabled.

## Step 8 — Submit and respond

Click **Add for Review** → **Submit to App Review**. Typical turnaround is
24–48 h. If it comes back:

- **Guideline 2.1 (crashes / cannot sign in)** → almost always the invite
  code or a market-hours confusion; reply in Resolution Center with the code
  and a screenshot of a populated Replay session.
- **Guideline 4.2 (minimum functionality / web wrapper)** → reply that the
  app provides native push (APNs) with time-sensitive delivery, native
  notification permission flow, and an offline state; attach a screenshot of
  a lock-screen alert. This is the most likely pushback for a remote-loaded
  shell. If they insist, the fallback is bundling the web app locally
  (copy `deploy/index.html` to `native/www/`, point its fetches at the Render
  origin) — ask for that work if needed.
- **Guideline 5.1.1 (data)** → point to Delete account in Settings and the
  privacy page.

When approved: App Store Connect → the version → **Release This Version**.

## After launch — things to do next (not blocking)

1. **Real Pro billing**: StoreKit 2 via `@capgo/capacitor-native-purchases` or
   RevenueCat, then re-enable the Pro button in store mode. Apple must be the
   payment path for digital subscriptions (3.1.1).
2. **Sign in with Apple**: required by 4.8 the moment Google sign-in is
   offered in the native build; both are hidden there today for that reason.
3. **Persistent device store**: `/tmp/scanner-devices.json` is wiped on every
   Render deploy; the app re-claims and re-registers on launch, but a push
   that fires between a deploy and the next app launch is lost. Move it to a
   Render disk or a small database before you have many users.
4. Bump `Build` in Xcode for every upload; `Version` only for store releases.
