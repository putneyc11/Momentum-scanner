import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var market: MarketStore
    @State private var accessToken = ""
    @State private var connecting = false
    var body: some View {
        Form {
            Section {
                HStack { Text("Connection"); Spacer(); HealthBadge() }
                if market.isSimulated {
                    Label("Preview mode uses simulated, frozen data.", systemImage: "info.circle").font(.caption).foregroundStyle(Palette.amber)
                }
            }
            Section {
                #if DEBUG
                TextField("https://your-service.onrender.com", text: $market.serverText)
                    .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Momentum server URL")
                #else
                LabeledContent("Server", value: market.serverText.isEmpty ? "Not configured" : market.serverText)
                    .font(.caption)
                #endif
                Button {
                    connecting = true
                    Task {
                        await market.signIn()
                        connecting = false
                        if market.mode == .connected { market.selectedTab = 0 }
                    }
                } label: {
                    HStack { Text(connecting ? "Signing in…" : "Sign in securely"); Spacer(); if connecting { ProgressView() } else { Image(systemName: "person.badge.key") } }
                }.disabled(connecting || !market.consumerSignInConfigured || market.serverText.isEmpty)
                if !market.consumerSignInConfigured {
                    Text("Account sign-in requires the app’s identity provider configuration. This development build has not been connected to a consumer sign-in service.").font(.caption).foregroundStyle(.secondary)
                }
                #if DEBUG
                SecureField(market.hasPrivateToken ? "Saved token · enter to replace" : "App access token", text: $accessToken)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                    .accessibilityLabel("App access token")
                Button {
                    connecting = true
                    Task {
                        await market.connect(accessToken: accessToken)
                        accessToken = ""
                        connecting = false
                        if market.mode == .connected { market.selectedTab = 0 }
                    }
                } label: {
                    HStack { Text(connecting ? "Connecting…" : "Connect private preview token"); Spacer(); if connecting { ProgressView() } else { Image(systemName: "lock.shield") } }
                }.disabled(connecting || market.serverText.isEmpty || (accessToken.isEmpty && !market.hasPrivateToken))
                #endif
                if let error = market.visibleError { Text(error).font(.caption).foregroundStyle(Palette.amber) }
            } header: { Text("Your server") } footer: {
                Text("Secure sign-in uses your account provider. Session tokens are kept in this device’s Keychain. Broker API keys belong only on the server. Manual access tokens are available only in a private Debug build.")
            }
            Section {
                HStack { Text("Data feed"); Spacer(); Text(market.feedName).foregroundStyle(.secondary) }
                HStack { Text("Live transport"); Spacer(); Text("Encrypted event stream").foregroundStyle(.secondary) }
                Text("Live updates pause when the app enters the background and reconnect when you return. Stale and unavailable data are labeled.").font(.caption).foregroundStyle(.secondary)
            } header: { Text("Data & connection") }
            Section {
                Button("Explore simulated preview", systemImage: "play.rectangle") { market.usePreview(); market.selectedTab = 0 }
                Button("Sign out and erase access token", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { Task { await market.signOut(); accessToken = "" } }
                    .disabled(!market.hasSavedToken && market.mode == .disconnected)
            }
            Section {
                LabeledContent("Application", value: "Momentum · Native iOS")
                LabeledContent("Version", value: "1.0 (development)")
                Text("Research and market observation. Momentum does not place trades from this app. A momentum score describes observed conditions; it does not predict a profitable trade.").font(.caption).foregroundStyle(.secondary)
            } header: { Text("About") }
        }
        .scrollContentBackground(.hidden).background(Palette.background)
        .navigationTitle("Settings")
        .onDisappear { accessToken = "" }
    }
}
