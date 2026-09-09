import SwiftUI

@main
struct MomentumApp: App {
    @StateObject private var market = MarketStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(market)
                .tint(Palette.mint)
                .preferredColorScheme(.dark)
                .task { await market.restoreSession() }
                .onChange(of: scenePhase) { _, phase in market.setForeground(phase == .active) }
        }
    }
}

enum Palette {
    static let background = Color(red: 0.035, green: 0.065, blue: 0.085)
    static let surface = Color(red: 0.065, green: 0.10, blue: 0.13)
    static let line = Color.white.opacity(0.09)
    static let mint = Color(red: 0.38, green: 0.91, blue: 0.74)
    static let red = Color(red: 1, green: 0.42, blue: 0.48)
    static let amber = Color(red: 1, green: 0.76, blue: 0.38)
}

enum Display {
    static func price(_ value: Double) -> String { value.formatted(.currency(code: "USD").precision(.fractionLength(value < 1 ? 4 : 2))) }
    static func number(_ value: Double) -> String { value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1))) }
    static func percent(_ value: Double) -> String { String(format: "%+.2f%%", value) }
    static func metric(_ value: Double?, precision: Int = 2) -> String { value.map { $0.formatted(.number.precision(.fractionLength(precision))) } ?? "—" }
}

struct RootView: View {
    @EnvironmentObject private var market: MarketStore
    var body: some View {
        TabView(selection: $market.selectedTab) {
            NavigationStack { ScannerView(watchlistOnly: false) }
                .tabItem { Label("Scanner", systemImage: "waveform.path.ecg") }.tag(0)
            NavigationStack { ScannerView(watchlistOnly: true) }
                .tabItem { Label("Watchlist", systemImage: "star") }.tag(1)
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "slider.horizontal.3") }.tag(2)
        }
    }
}

struct HealthBadge: View {
    @EnvironmentObject private var market: MarketStore
    var color: Color {
        switch market.connection { case .live: Palette.mint; case .preview, .connecting, .stale: Palette.amber; case .offline, .paused: .secondary }
    }
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(market.connection.rawValue.uppercased()).font(.system(size: 10, weight: .bold, design: .monospaced))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9).padding(.vertical, 6)
        .background(color.opacity(0.1), in: Capsule())
        .accessibilityLabel("Data connection: \(market.connection.rawValue)")
    }
}

struct Panel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content.padding(16).background(Palette.surface, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Palette.line, lineWidth: 1))
    }
}

struct Eyebrow: View {
    var text: String
    var body: some View { Text(text.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.2).foregroundStyle(.secondary) }
}

struct Metric: View {
    var title: String
    var value: String
    var color: Color = .primary
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Eyebrow(text: title)
            Text(value).font(.system(.title3, design: .monospaced).weight(.semibold)).foregroundStyle(color).minimumScaleFactor(0.6).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
