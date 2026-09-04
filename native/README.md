# native/ — iOS App Store shell

Capacitor project that wraps the deployed web app (`server.url` in
`capacitor.config.json`) in a native container and adds APNs push. The web
app is not bundled: the shell loads it from Render, so every web deploy ships
to the native app instantly without an App Store review.

Everything that needs a Mac (Xcode, signing, TestFlight upload) is in
`docs/APP_STORE.md`. Nothing in this folder is run by the Render deploy.

- `capacitor.config.json` — app id, remote URL, plugin config
- `assets/` — 1024 icon + 2732 splash; `npm run assets` renders every size
- `ios-extras/PrivacyInfo.xcprivacy` — required privacy manifest
- `scripts/ios-setup.sh` — patches Info.plist after `cap add ios`
- `store/metadata.md` — App Store Connect copy, privacy answers, review notes
- `www/` — offline fallback page only

The `ios/` folder is generated on the Mac and is git-ignored.
