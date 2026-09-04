#!/usr/bin/env bash
# Run on the Mac right after `npx cap add ios`. Idempotent.
# Patches Info.plist, drops in the privacy manifest, and sets iPhone-only +
# portrait so App Store Connect does not demand iPad screenshots.
set -euo pipefail
cd "$(dirname "$0")/.."
PLIST="ios/App/App/Info.plist"
PB="/usr/libexec/PlistBuddy"
[ -f "$PLIST" ] || { echo "ios/ not found — run: npx cap add ios"; exit 1; }
set_key() { $PB -c "Set :$1 $2" "$PLIST" 2>/dev/null || $PB -c "Add :$1 $3 $2" "$PLIST"; }
set_key ITSAppUsesNonExemptEncryption false bool
set_key CFBundleDisplayName "Momentum Scanner" string
set_key UIRequiresFullScreen true bool
$PB -c "Delete :UIBackgroundModes" "$PLIST" 2>/dev/null || true
$PB -c "Add :UIBackgroundModes array" "$PLIST"
$PB -c "Add :UIBackgroundModes:0 string remote-notification" "$PLIST"
$PB -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
$PB -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
$PB -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"
$PB -c "Delete :UISupportedInterfaceOrientations~ipad" "$PLIST" 2>/dev/null || true
cp ios-extras/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
# iPhone only
sed -i '' 's/TARGETED_DEVICE_FAMILY = "1,2";/TARGETED_DEVICE_FAMILY = 1;/g' ios/App/App.xcodeproj/project.pbxproj || true
echo "Info.plist patched, privacy manifest copied, iPhone-only set."
echo "Still manual in Xcode: Signing team, Push Notifications capability, Time Sensitive Notifications capability, add PrivacyInfo.xcprivacy to the App target if Xcode did not pick it up."
