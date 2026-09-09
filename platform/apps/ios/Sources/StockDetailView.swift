import SwiftUI

struct StockDetailView: View {
    @EnvironmentObject private var market: MarketStore
    let symbol: String
    @State private var timeframe: Timeframe = .minute
    @State private var section = 0
    private var key: String { MarketStore.detailKey(symbol, timeframe) }
    private var detail: StockDetail? { market.details[key] }
    private var stock: Stock? { market.stocks.first { $0.symbol == symbol } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                priceHeader
                if market.isSimulated {
                    Label("Simulated preview · not current prices", systemImage: "info.circle").font(.caption).foregroundStyle(Palette.amber)
                } else if market.connection != .live {
                    Label("\(market.connection.rawValue) data · prices may be delayed", systemImage: "clock.badge.exclamationmark").font(.caption).foregroundStyle(Palette.amber)
                }
                Panel {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack { Eyebrow(text: "Price & volume"); Spacer(); HealthBadge() }
                        Picker("Candle interval", selection: $timeframe) {
                            ForEach(Timeframe.allCases) { Text($0.label).tag($0) }
                        }.pickerStyle(.segmented)
                        if let detail, !detail.bars.isEmpty {
                            CandlestickChart(bars: detail.bars, timeframe: timeframe)
                        } else if let error = market.detailErrors[key] {
                            VStack(spacing: 12) {
                                ContentUnavailableView("Chart unavailable", systemImage: "chart.xyaxis.line", description: Text(error))
                                Button("Try again") { Task { await market.loadDetail(symbol, timeframe: timeframe) } }
                            }
                        } else if detail != nil {
                            ContentUnavailableView("No bars for this interval", systemImage: "chart.xyaxis.line", description: Text("Try another interval or wait for new trades."))
                        } else {
                            ProgressView("Loading candles & analysis…").frame(maxWidth: .infinity).frame(height: 270)
                        }
                    }
                }
                if let quote = detail?.quote {
                    Panel {
                        HStack {
                            Metric(title: "Bid", value: quote.bid.map(Display.price) ?? "—", color: Palette.mint)
                            Metric(title: "Ask", value: quote.ask.map(Display.price) ?? "—", color: Palette.red)
                            Metric(title: "Spread", value: "\(Display.metric(quote.spreadBps, precision: 1)) bps")
                        }
                    }
                }
                Picker("Details", selection: $section) {
                    Text("Analysis").tag(0); Text("Time & Sales").tag(1)
                }.pickerStyle(.segmented)
                if section == 0 { analysisSection } else { tapeSection }
            }.padding(20)
        }
        .background(Palette.background)
        .navigationTitle(symbol).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { market.toggleFavorite(symbol) } label: { Image(systemName: market.favorites.contains(symbol) ? "star.fill" : "star") }
                    .accessibilityLabel(market.favorites.contains(symbol) ? "Remove \(symbol) from watchlist" : "Add \(symbol) to watchlist")
            }
        }
        .task(id: key) { await market.loadDetail(symbol, timeframe: timeframe) }
        .refreshable { await market.loadDetail(symbol, timeframe: timeframe) }
    }
    private var priceHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Eyebrow(text: "\(symbol) / \(market.feedName)")
                Spacer()
                if let score = detail?.analysis?.score ?? stock?.score {
                    Text("\(Int(score)) momentum").font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(Palette.mint)
                }
            }
            Text((stock?.price ?? detail?.bars.last?.close).map(Display.price) ?? "—")
                .font(.system(size: 43, weight: .semibold, design: .rounded)).monospacedDigit().tracking(-1.2)
                .contentTransition(.numericText())
            HStack {
                if let stock {
                    Label(Display.percent(stock.changePct), systemImage: stock.changePct >= 0 ? "arrow.up.right" : "arrow.down.right")
                        .font(.system(.subheadline, design: .monospaced).weight(.medium)).foregroundStyle(stock.changePct >= 0 ? Palette.mint : Palette.red)
                    Text("today").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(stock.map { Display.number($0.volume) } ?? "—") volume").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    @ViewBuilder private var analysisSection: some View {
        if let analysis = detail?.analysis {
            Panel {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        Eyebrow(text: "Market read")
                        Spacer()
                        Text(analysis.trend ?? "Unclassified").font(.caption.weight(.semibold)).foregroundStyle(Palette.mint)
                    }
                    Text(analysis.summary ?? "No summary available for this interval.").font(.subheadline).lineSpacing(4)
                    Divider().overlay(Palette.line)
                    HStack {
                        Metric(title: "VWAP", value: Display.metric(analysis.vwap))
                        Metric(title: "RSI · 14", value: Display.metric(analysis.rsi, precision: 1))
                        Metric(title: "ATR · 14", value: Display.metric(analysis.atr))
                    }
                    HStack {
                        Metric(title: "EMA · 8", value: Display.metric(analysis.ema8))
                        Metric(title: "EMA · 21", value: Display.metric(analysis.ema21))
                        Metric(title: "Rel volume", value: "\(Display.metric(stock?.relativeVolume, precision: 1))×")
                    }
                    Text("Analysis is computed automatically from the selected interval. Pull to refresh the indicators. Streaming trades update the candles and tape immediately.").font(.caption2).foregroundStyle(.secondary)
                }
            }
            DisclosureGroup("What do these indicators mean?") {
                VStack(alignment: .leading, spacing: 12) {
                    definition("Momentum score", "A ranking of current conditions, not a probability of profit.")
                    definition("VWAP", "The volume-weighted average price of the bars supplied for this session.")
                    definition("RSI", "A 0–100 measure of recent price strength. High readings can persist in a strong trend.")
                    definition("ATR", "Average true range measures volatility in price units. It describes movement, not direction.")
                    definition("Relative volume", "Current participation compared with the server’s reference baseline.")
                    definition("Spread", "The gap between bid and ask in basis points. A wider spread can increase trading costs.")
                }.padding(.top, 12)
            }.font(.subheadline).padding(16).background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
        } else if detail != nil {
            ContentUnavailableView("Analysis is not available", systemImage: "waveform.path", description: Text("There may not be enough bars to calculate indicators yet."))
        }
    }
    private var tapeSection: some View {
        Panel {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Eyebrow(text: "Time & Sales"); Spacer(); Text("Last 100 prints").font(.caption2).foregroundStyle(.secondary) }
                HStack { Text("TIME · DEVICE LOCAL"); Spacer(); Text("PRICE"); Text("SIZE").frame(width: 52, alignment: .trailing) }
                    .font(.system(size: 9, weight: .medium, design: .monospaced)).foregroundStyle(.secondary)
                if let trades = detail?.trades, !trades.isEmpty {
                    ForEach(Array(trades.enumerated()), id: \.element.id) { index, trade in
                        HStack {
                            Text(DateParsing.parse(trade.time)?.formatted(date: .omitted, time: .standard) ?? "—").foregroundStyle(.secondary)
                            Spacer()
                            Text(Display.price(trade.price)).foregroundStyle(tradeColor(trade, index: index, trades: trades))
                            Text(Display.number(trade.size)).frame(width: 52, alignment: .trailing)
                        }.font(.system(size: 12, design: .monospaced))
                        if index < trades.count - 1 { Divider().overlay(Palette.line) }
                    }
                } else {
                    ContentUnavailableView("Waiting for trades", systemImage: "list.bullet.rectangle", description: Text("New prints appear here when trades arrive for \(symbol). Check the connection status if the market is active."))
                }
            }
        }
    }
    private func tradeColor(_ trade: TradePrint, index: Int, trades: [TradePrint]) -> Color {
        guard index + 1 < trades.count else { return .primary }
        return trade.price == trades[index + 1].price ? .primary : (trade.price > trades[index + 1].price ? Palette.mint : Palette.red)
    }
    private func definition(_ title: String, _ description: String) -> some View {
        VStack(alignment: .leading, spacing: 3) { Text(title).font(.caption.weight(.semibold)); Text(description).font(.caption).foregroundStyle(.secondary) }
    }
}
