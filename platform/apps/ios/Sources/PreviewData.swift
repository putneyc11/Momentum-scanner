import Foundation

/// Deterministic, explicitly labeled local fixture. Never used as a fallback to live data.
enum PreviewData {
    static let stocks: [Stock] = [
        Stock(symbol: "NVDA", price: 128.46, changePct: 4.82, volume: 86_200_000, relativeVolume: 3.4, score: 92, spreadBps: 1.6),
        Stock(symbol: "PLTR", price: 32.18, changePct: 8.21, volume: 24_180_000, relativeVolume: 5.2, score: 88, spreadBps: 3.1),
        Stock(symbol: "TSLA", price: 218.64, changePct: 3.76, volume: 43_900_000, relativeVolume: 2.1, score: 84, spreadBps: 1.4),
        Stock(symbol: "AMD", price: 152.73, changePct: 2.93, volume: 18_300_000, relativeVolume: 2.8, score: 79, spreadBps: 2.0),
        Stock(symbol: "AAPL", price: 224.12, changePct: 1.23, volume: 12_500_000, relativeVolume: 1.3, score: 71, spreadBps: 0.9),
        Stock(symbol: "SOFI", price: 8.36, changePct: -1.65, volume: 22_800_000, relativeVolume: 1.8, score: 58, spreadBps: 12.0),
        Stock(symbol: "META", price: 516.42, changePct: 0.82, volume: 5_400_000, relativeVolume: 1.2, score: 65, spreadBps: 1.2)
    ]
    static func detail(_ symbol: String, timeframe: Timeframe) -> StockDetail {
        let price = stocks.first { $0.symbol == symbol }?.price ?? 100
        let end: Double = 1_788_974_400
        var bars: [PriceBar] = (0..<180).map { index in
            let i = Double(index)
            let center = price * (0.962 + i * 0.00022 + sin(i * 0.14) * 0.004 + sin(i * 0.61) * 0.0018)
            let open = center - sin(i * 1.73) * price * 0.0012
            let close = center + cos(i * 1.11) * price * 0.001
            return PriceBar(time: end - Double(179 - index) * timeframe.seconds, open: open, high: max(open, close) + price * 0.0008, low: min(open, close) - price * 0.0009, close: close, volume: 1400 + abs(sin(i * 1.19)) * 9600)
        }
        let ratio = price / (bars.last?.close ?? price)
        bars = bars.map { PriceBar(time: $0.time, open: $0.open * ratio, high: $0.high * ratio, low: $0.low * ratio, close: $0.close * ratio, volume: $0.volume) }
        return StockDetail(symbol: symbol, bars: bars, trades: (0..<30).map { index in
            TradePrint(id: "preview-\(index)", time: DateParsing.iso(Date(timeIntervalSince1970: end - Double(index * 3))), price: price + sin(Double(index)) * 0.04, size: Double((index % 7 + 1) * 100))
        }, analysis: Analysis(score: stocks.first { $0.symbol == symbol }?.score, trend: "Uptrend", vwap: price * 0.987, ema8: price * 0.998, ema21: price * 0.992, atr: price * 0.008, rsi: 62.4, summary: "Preview analysis: price is above VWAP and the short moving averages. Volume is elevated relative to the sample baseline. These are simulated values, not a trading signal."), quote: Quote(bid: price - 0.01, ask: price + 0.01, spreadBps: 1.6), feed: .preview)
    }
}
