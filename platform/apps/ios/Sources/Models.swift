import Foundation

enum Timeframe: String, CaseIterable, Identifiable, Codable {
    case minute = "1Min", fiveMinutes = "5Min", fifteenMinutes = "15Min", hour = "1Hour", day = "1Day"
    var id: String { rawValue }
    var label: String {
        switch self { case .minute: "1m"; case .fiveMinutes: "5m"; case .fifteenMinutes: "15m"; case .hour: "1h"; case .day: "1D" }
    }
    var seconds: TimeInterval {
        switch self { case .minute: 60; case .fiveMinutes: 300; case .fifteenMinutes: 900; case .hour: 3600; case .day: 86400 }
    }
}

struct FeedStatus: Codable, Equatable {
    var state: String
    var feed: String?
    var lastEventAt: String?
    var error: String?
    var isLive: Bool { state == "live" || state == "connected" }
    static let offline = FeedStatus(state: "offline")
    static let preview = FeedStatus(state: "preview", feed: "Simulated")
}

struct Stock: Codable, Identifiable, Equatable {
    var symbol: String
    var price: Double
    var changePct: Double
    var volume: Double
    var relativeVolume: Double?
    var score: Double?
    var spreadBps: Double?
    var updatedAt: String?
    var id: String { symbol }
}

struct ScannerSnapshot: Codable {
    var asOf: String?
    var feed: FeedStatus
    var stocks: [Stock]
}

struct PriceBar: Codable, Identifiable, Equatable {
    var time: Double
    var open: Double
    var high: Double
    var low: Double
    var close: Double
    var volume: Double
    var id: Double { time }
    var date: Date { Date(timeIntervalSince1970: time) }
}

struct TradePrint: Codable, Identifiable, Equatable {
    var id: String
    var time: String
    var price: Double
    var size: Double
    init(id: String, time: String, price: Double, size: Double) {
        self.id = id; self.time = time; self.price = price; self.size = size
    }
    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? box.decode(String.self, forKey: .id) { id = value }
        else { id = String(try box.decode(Int64.self, forKey: .id)) }
        time = try box.decode(String.self, forKey: .time)
        price = try box.decode(Double.self, forKey: .price)
        size = try box.decode(Double.self, forKey: .size)
    }
}

struct Analysis: Codable {
    var score: Double?
    var trend: String?
    var vwap: Double?
    var ema8: Double?
    var ema21: Double?
    var atr: Double?
    var rsi: Double?
    var summary: String?
}

struct Quote: Codable {
    var bid: Double?
    var ask: Double?
    var spreadBps: Double?
}

struct StockDetail: Codable {
    var symbol: String
    var bars: [PriceBar]
    var trades: [TradePrint]
    var analysis: Analysis?
    var quote: Quote?
    var feed: FeedStatus
}

/// Own-server event contract. Upstream broker credentials and messages never enter the app.
struct Tick: Codable {
    var symbol: String
    var price: Double
    var size: Double?
    var time: String
    var id: String?
    init(symbol: String, price: Double, size: Double?, time: String, id: String?) {
        self.symbol = symbol; self.price = price; self.size = size; self.time = time; self.id = id
    }
    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        symbol = try box.decode(String.self, forKey: .symbol)
        price = try box.decode(Double.self, forKey: .price)
        size = try box.decodeIfPresent(Double.self, forKey: .size)
        time = try box.decode(String.self, forKey: .time)
        if let text = try? box.decode(String.self, forKey: .id) { id = text }
        else if let number = try? box.decode(Int64.self, forKey: .id) { id = String(number) }
        else { id = nil }
    }
}

enum DateParsing {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func iso(_ value: Date) -> String { ISO8601DateFormatter().string(from: value) }
}

enum ChartWindow {
    static func range(count: Int, visible: Int, offset: Int) -> Range<Int> {
        guard count > 0 else { return 0..<0 }
        let size = min(count, max(1, visible))
        let end = max(size, count - max(0, min(count - size, offset)))
        return (end - size)..<end
    }
    static func update(_ bars: [PriceBar], tick: Tick, timeframe: Timeframe) -> [PriceBar] {
        guard tick.price.isFinite, tick.price > 0, let date = DateParsing.parse(tick.time) else { return bars }
        let bucket: TimeInterval
        if timeframe == .day {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "America/New_York")!
            bucket = calendar.startOfDay(for: date).timeIntervalSince1970
        } else { bucket = floor(date.timeIntervalSince1970 / timeframe.seconds) * timeframe.seconds }
        var result = bars
        // Ignore out-of-order trades for the candle tail; the tape still includes them.
        if let last = result.last {
            if bucket < last.time { return bars }
            if bucket == last.time {
                result[result.count - 1] = PriceBar(time: last.time, open: last.open, high: max(last.high, tick.price), low: min(last.low, tick.price), close: tick.price, volume: last.volume + max(0, tick.size ?? 0))
                return result
            }
        }
        result.append(PriceBar(time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: max(0, tick.size ?? 0)))
        return Array(result.suffix(1500))
    }
}
