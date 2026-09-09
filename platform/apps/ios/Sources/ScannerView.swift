import SwiftUI

enum StockSort: String, CaseIterable, Identifiable {
    case score = "Momentum", change = "Change %", volume = "Volume", symbol = "Symbol"
    var id: String { rawValue }
}

struct ScannerView: View {
    @EnvironmentObject private var market: MarketStore
    let watchlistOnly: Bool
    @State private var search = ""
    @State private var sort: StockSort = .score
    var filtered: [Stock] {
        market.stocks.filter { stock in
            (!watchlistOnly || market.favorites.contains(stock.symbol)) && (search.isEmpty || stock.symbol.localizedCaseInsensitiveContains(search))
        }.sorted { lhs, rhs in
            switch sort {
            case .score: (lhs.score ?? 0) == (rhs.score ?? 0) ? lhs.symbol < rhs.symbol : (lhs.score ?? 0) > (rhs.score ?? 0)
            case .change: lhs.changePct > rhs.changePct
            case .volume: lhs.volume > rhs.volume
            case .symbol: lhs.symbol < rhs.symbol
            }
        }
    }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                header
                if market.isSimulated {
                    Label("Preview · Simulated prices, frozen sample session", systemImage: "info.circle")
                        .font(.caption).foregroundStyle(Palette.amber)
                }
                if let error = market.visibleError, market.mode != .preview {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Connection needs attention", systemImage: "wifi.exclamationmark").font(.subheadline.weight(.semibold))
                        Text(error).font(.caption).foregroundStyle(.secondary)
                        Button("Open Settings") { market.selectedTab = 2 }.font(.caption.weight(.semibold))
                    }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Palette.amber.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                }
                if market.mode == .disconnected { welcome }
                else {
                    if !watchlistOnly { overview }
                    HStack {
                        Eyebrow(text: "\(filtered.count) \(watchlistOnly ? "saved symbols" : "ranked symbols")")
                        Spacer()
                        Menu {
                            Picker("Sort by", selection: $sort) { ForEach(StockSort.allCases) { Text($0.rawValue).tag($0) } }
                        } label: { Label(sort.rawValue, systemImage: "arrow.up.arrow.down").font(.caption.weight(.medium)) }
                    }
                    if filtered.isEmpty {
                        ContentUnavailableView(watchlistOnly ? "Your watchlist is quiet" : "No matching symbols", systemImage: watchlistOnly ? "star" : "magnifyingglass", description: Text(watchlistOnly ? "Star a symbol in Scanner to save it here. Saved symbols appear when they are in the current scanner universe." : "Try another symbol or refresh the scanner."))
                    } else {
                        ForEach(Array(filtered.enumerated()), id: \.element.id) { rank, stock in
                            NavigationLink(value: stock.symbol) { StockRow(stock: stock, rank: rank + 1) }.buttonStyle(.plain).accessibilityIdentifier("stock-row-\(stock.symbol)")
                        }
                    }
                    HStack(spacing: 5) {
                        Image(systemName: "clock")
                        if market.isSimulated { Text("Sample prices are not current market data.") }
                        else if let date = market.lastUpdated { Text("Snapshot \(date.formatted(date: .omitted, time: .standard)) · \(market.feedName)") }
                        else { Text("Waiting for the first market snapshot.") }
                    }.font(.caption2).foregroundStyle(.secondary).padding(.top, 8)
                }
            }.padding(20)
        }
        .background(Palette.background)
        .navigationTitle(watchlistOnly ? "Watchlist" : "Momentum")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { HealthBadge() } }
        .searchable(text: $search, prompt: "Find a symbol")
        .refreshable { await market.refresh() }
        .navigationDestination(for: String.self) { symbol in StockDetailView(symbol: symbol) }
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: watchlistOnly ? "Your market, in focus" : "Find the next move")
            Text(watchlistOnly ? "Keep your edge." : "Follow the momentum.")
                .font(.system(size: 30, weight: .semibold, design: .rounded)).tracking(-0.8)
            Text(watchlistOnly ? "A focused view of the names you follow." : "Price, participation, and momentum. Together.")
                .font(.subheadline).foregroundStyle(.secondary)
        }.padding(.top, 8)
    }
    private var overview: some View {
        Panel {
            HStack {
                Metric(title: "Universe", value: "\(market.stocks.count)")
                Rectangle().fill(Palette.line).frame(width: 1, height: 38).padding(.horizontal, 6)
                Metric(title: "Advancing", value: "\(market.advancing)", color: Palette.mint)
                Rectangle().fill(Palette.line).frame(width: 1, height: 38).padding(.horizontal, 6)
                Metric(title: "Avg score", value: "\(market.meanScore)")
            }
        }
    }
    private var welcome: some View {
        Panel {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "waveform.path.ecg.rectangle").font(.system(size: 36)).foregroundStyle(Palette.mint)
                Text("Your market starts here.").font(.title2.weight(.semibold))
                Text("Connect your Momentum server to see the scanner, live candles, and every trade as it arrives.").font(.subheadline).foregroundStyle(.secondary)
                Button { market.selectedTab = 2 } label: { Text("Connect your server").frame(maxWidth: .infinity).padding(.vertical, 6) }.buttonStyle(.borderedProminent).foregroundStyle(Palette.background)
                Button("Explore a simulated preview") { market.usePreview() }.font(.subheadline).frame(maxWidth: .infinity)
            }
        }.padding(.top, 10)
    }
}

struct StockRow: View {
    @EnvironmentObject private var market: MarketStore
    var stock: Stock
    var rank: Int
    var body: some View {
        HStack(spacing: 14) {
            VStack(spacing: 4) {
                Text(stock.score.map { String(Int($0)) } ?? "—").font(.system(.headline, design: .monospaced)).foregroundStyle(Palette.mint)
                Text("SCORE").font(.system(size: 7, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary)
            }.frame(width: 48, height: 50).background(Palette.mint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 5) {
                    Text(stock.symbol).font(.headline)
                    if market.favorites.contains(stock.symbol) { Image(systemName: "star.fill").font(.system(size: 8)).foregroundStyle(Palette.amber) }
                }
                Text("\(Display.number(stock.volume)) vol · \(Display.metric(stock.relativeVolume, precision: 1))× RVOL")
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 7) {
                Text(Display.price(stock.price)).font(.system(.subheadline, design: .monospaced).weight(.semibold))
                Text(Display.percent(stock.changePct)).font(.system(.caption, design: .monospaced).weight(.semibold)).foregroundStyle(stock.changePct >= 0 ? Palette.mint : Palette.red)
            }
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).foregroundStyle(.tertiary)
        }.padding(14).background(Palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.line, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(stock.symbol), \(Display.price(stock.price)), change \(Display.percent(stock.changePct)), momentum score \(stock.score.map { String(Int($0)) } ?? "unavailable")")
        .contextMenu { Button(market.favorites.contains(stock.symbol) ? "Remove from watchlist" : "Add to watchlist", systemImage: market.favorites.contains(stock.symbol) ? "star.slash" : "star") { market.toggleFavorite(stock.symbol) } }
    }
}
