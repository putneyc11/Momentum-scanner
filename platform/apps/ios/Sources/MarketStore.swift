import Foundation
import SwiftUI

@MainActor
final class MarketStore: ObservableObject {
    enum Mode: String { case disconnected, connected, preview }
    enum Connection: String { case offline = "Offline", connecting = "Connecting", live = "Live", stale = "Stale", preview = "Preview", paused = "Paused" }
    @Published private(set) var stocks: [Stock] = []
    @Published private(set) var details: [String: StockDetail] = [:]
    @Published private(set) var detailErrors: [String: String] = [:]
    @Published private(set) var mode: Mode = .disconnected
    @Published private(set) var connection: Connection = .offline
    @Published private(set) var feed = FeedStatus.offline
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var error: String?
    @Published private(set) var isRefreshing = false
    @Published private(set) var favorites: Set<String>
    @Published var selectedTab = 0
    @Published var serverText: String
    @Published private(set) var hasSavedToken = false
    private let vault = TokenVault()
    private let api = APIClient()
    private let oauth = OAuthClient()
    private let webSignIn = WebSignIn()
    private var usesOAuth = false
    private var refreshID: UUID?
    private var token: String?
    private var base: ServerAddress?
    private var streamTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var generation = 0
    private var inFlightDetails: Set<String> = []
    private var isForeground = true
    private var recentTickIDs: Set<String> = []
    private var recentTickOrder: [String] = []
    private var lastStreamMessage: Date?

    init() {
        serverText = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        #if !DEBUG
        serverText = Bundle.main.object(forInfoDictionaryKey: "MomentumServerURL") as? String ?? ""
        #endif
        favorites = Set(UserDefaults.standard.stringArray(forKey: "watchlist") ?? ["NVDA", "AAPL", "TSLA"])
        #if DEBUG
        do { token = try vault.read(); hasSavedToken = token != nil }
        catch { self.error = error.localizedDescription }
        #endif
        if ProcessInfo.processInfo.arguments.contains("--preview") { usePreview() }
    }

    var visibleError: String? { error ?? feed.error }
    var feedName: String { feed.feed?.uppercased() ?? "MARKET DATA" }
    var meanScore: Int { let scores = stocks.compactMap(\.score); return scores.isEmpty ? 0 : Int(scores.reduce(0, +) / Double(scores.count)) }
    var advancing: Int { stocks.filter { $0.changePct > 0 }.count }
    var consumerSignInConfigured: Bool { OAuthConfiguration.load() != nil }
    var hasPrivateToken: Bool { hasSavedToken && !usesOAuth }
    var isSimulated: Bool { mode == .preview || feed.state == "demo" || feed.state == "preview" }

    func toggleFavorite(_ symbol: String) {
        if favorites.contains(symbol) { favorites.remove(symbol) } else { favorites.insert(symbol) }
        UserDefaults.standard.set(favorites.sorted(), forKey: "watchlist")
    }

    func connect(accessToken: String = "") async {
        #if !DEBUG
        error = "Use secure account sign-in in this release build."
        return
        #else
        stopTasks()
        let attempt = generation
        error = nil
        connection = .connecting
        do {
            let address = try ServerAddress(serverText)
            let supplied = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let candidate = supplied.isEmpty ? (usesOAuth ? nil : token) : supplied, !candidate.isEmpty else { throw ServiceError.tokenMissing }
            try await api.checkSession(base: address, token: candidate)
            guard attempt == generation else { return }
            try vault.save(candidate)
            token = candidate; hasSavedToken = true; base = address
            usesOAuth = false
            UserDefaults.standard.set(address.url.absoluteString, forKey: "serverURL")
            mode = .connected
            stocks = []; details = [:]; detailErrors = [:]
            feed = .offline
            await refresh()
            guard attempt == generation, mode == .connected, isForeground else { return }
            startTasks()
        } catch {
            guard attempt == generation else { return }
            self.error = error.localizedDescription
            connection = .offline
            mode = .disconnected
        }
        #endif
    }

    func signIn() async {
        stopTasks()
        let attempt = generation
        error = nil; connection = .connecting; mode = .disconnected
        do {
            guard let config = OAuthConfiguration.load() else { throw OAuthError.notConfigured }
            let address = try ServerAddress(serverText)
            let provider = try await oauth.discovery(config)
            let verifier = try PKCE.random()
            let state = try PKCE.random()
            let url = try PKCE.authorizationURL(config: config, provider: provider, verifier: verifier, state: state)
            let callback = try await webSignIn.authorize(url: url, callbackScheme: config.redirect.scheme!)
            guard attempt == generation else { return }
            let code = try PKCE.code(from: callback, config: config, state: state)
            let session = try await oauth.exchange(code: code, verifier: verifier, config: config, provider: provider)
            try await oauth.validateSession(accessToken: session.accessToken) { [api] credential in
                try await api.checkSession(base: address, token: credential)
            }
            guard attempt == generation else { return }
            usesOAuth = true; token = session.accessToken; hasSavedToken = true; base = address
            UserDefaults.standard.set(address.url.absoluteString, forKey: "serverURL")
            mode = .connected; stocks = []; details = [:]; detailErrors = [:]; feed = .offline
            await refresh()
            if attempt == generation, isForeground, mode == .connected { startTasks() }
        } catch {
            guard attempt == generation else { return }
            hasSavedToken = await oauth.hasSavedSession()
            usesOAuth = hasSavedToken
            if !hasSavedToken { token = nil }
            self.error = error.localizedDescription; connection = .offline; mode = .disconnected
        }
    }

    func restoreSession() async {
        guard mode == .disconnected, !serverText.isEmpty, streamTask == nil else { return }
        let attempt = generation
        if let config = OAuthConfiguration.load(), await oauth.hasSavedSession() {
            do {
                let address = try ServerAddress(serverText)
                let credential = try await oauth.accessToken(config: config)
                try await oauth.validateSession(accessToken: credential) { [api] candidate in
                    try await api.checkSession(base: address, token: candidate)
                }
                guard attempt == generation, mode == .disconnected else { return }
                usesOAuth = true; token = credential; hasSavedToken = true; base = address; mode = .connected
                await refresh()
                if mode == .connected, isForeground { startTasks() }
            } catch {
                if attempt == generation {
                    hasSavedToken = await oauth.hasSavedSession(); usesOAuth = hasSavedToken
                    if !hasSavedToken { token = nil }
                    self.error = error.localizedDescription; connection = .offline
                }
            }
            return
        }
        guard hasSavedToken else { return }
        await connect()
    }

    func usePreview() {
        stopTasks()
        mode = .preview; connection = .preview; feed = .preview; error = nil
        stocks = PreviewData.stocks
        details = [:]; detailErrors = [:]; lastUpdated = nil
    }

    func signOut() async {
        stopTasks()
        do { try vault.clear(); try await oauth.clear(); hasSavedToken = false; token = nil; usesOAuth = false }
        catch { self.error = error.localizedDescription }
        base = nil; stocks = []; details = [:]; detailErrors = [:]
        mode = .disconnected; connection = .offline; feed = .offline; lastUpdated = nil
    }

    func setForeground(_ foreground: Bool) {
        isForeground = foreground
        guard mode == .connected else { return }
        if foreground { startTasks() }
        else { stopTasks(); connection = .paused }
    }

    func refresh() async {
        guard mode == .connected, !isRefreshing, let base, let token else { return }
        let attempt = generation
        let operation = UUID()
        refreshID = operation
        isRefreshing = true
        defer { if refreshID == operation { isRefreshing = false; refreshID = nil } }
        do {
            let credential = try await activeToken(fallback: token)
            let snapshot = try await api.scanner(base: base, token: credential)
            guard attempt == generation else { return }
            apply(snapshot)
            error = nil
        } catch {
            guard attempt == generation, !Task.isCancelled else { return }
            self.error = error.localizedDescription
            if Self.requiresSignIn(error) {
                if error as? ServiceError == .unauthorized, usesOAuth { try? await oauth.clear() }
                if usesOAuth { hasSavedToken = await oauth.hasSavedSession() }
                stopTasks(); mode = .disconnected; connection = .offline
            }
            else { connection = stocks.isEmpty ? .offline : .stale }
        }
    }

    static func detailKey(_ symbol: String, _ timeframe: Timeframe) -> String { "\(symbol)|\(timeframe.rawValue)" }

    func loadDetail(_ symbol: String, timeframe: Timeframe) async {
        let key = Self.detailKey(symbol, timeframe)
        if mode == .preview { details[key] = PreviewData.detail(symbol, timeframe: timeframe); return }
        guard mode == .connected, let base, let token, !inFlightDetails.contains(key) else { return }
        let attempt = generation
        let operationKey = "\(attempt)|\(key)"
        guard !inFlightDetails.contains(operationKey) else { return }
        inFlightDetails.insert(operationKey)
        defer { inFlightDetails.remove(operationKey) }
        do {
            let credential = try await activeToken(fallback: token)
            var detail = try await api.detail(symbol: symbol, timeframe: timeframe, base: base, token: credential)
            try Task.checkCancellation()
            guard attempt == generation else { return }
            detail.bars = detail.bars.filter { $0.open.isFinite && $0.close.isFinite && $0.high.isFinite && $0.low.isFinite }.sorted { $0.time < $1.time }
            detail.trades = Array(detail.trades.sorted { $0.time > $1.time }.prefix(100))
            // Preserve prints received while a slower REST refresh was in flight.
            if let current = details[key], let restNewest = detail.trades.first?.time {
                let ids = Set(detail.trades.map(\.id))
                let newer = current.trades.filter { !ids.contains($0.id) && $0.time >= restNewest }.sorted { $0.time < $1.time }
                for trade in newer {
                    detail.bars = ChartWindow.update(detail.bars, tick: Tick(symbol: symbol, price: trade.price, size: trade.size, time: trade.time, id: trade.id), timeframe: timeframe)
                }
                detail.trades = Array((newer + detail.trades).sorted { $0.time > $1.time }.prefix(100))
            }
            details[key] = detail; detailErrors[key] = nil
        } catch {
            guard attempt == generation, !Task.isCancelled else { return }
            detailErrors[key] = error.localizedDescription
        }
    }

    private func stopTasks() {
        generation += 1
        isRefreshing = false; refreshID = nil
        streamTask?.cancel(); streamTask = nil
        refreshTask?.cancel(); refreshTask = nil
        lastStreamMessage = nil
        recentTickIDs.removeAll(); recentTickOrder.removeAll()
    }

    private func startTasks() {
        guard mode == .connected, isForeground, streamTask == nil, let base, let token else { return }
        let attempt = generation
        connection = .connecting
        streamTask = Task { [weak self, api] in
            var failures = 0
            while !Task.isCancelled {
                do {
                    guard let credential = try await self?.activeToken(fallback: token) else { return }
                    try await api.stream(base: base, token: credential) { [weak self] event in
                        await self?.receive(event, generation: attempt)
                    }
                } catch {
                    guard !Task.isCancelled, let self, self.generation == attempt else { return }
                    if Self.requiresSignIn(error) {
                        if error as? ServiceError == .unauthorized, self.usesOAuth { try? await self.oauth.clear() }
                        if self.usesOAuth { self.hasSavedToken = await self.oauth.hasSavedSession() }
                        self.error = error.localizedDescription
                        self.mode = .disconnected; self.connection = .offline
                        self.refreshTask?.cancel(); self.refreshTask = nil
                        self.streamTask = nil
                        return
                    }
                    self.connection = self.stocks.isEmpty ? .offline : .stale
                    self.error = "Live connection interrupted. Reconnecting automatically."
                    if let last = self.lastStreamMessage, Date().timeIntervalSince(last) < 30 { failures = 0 }
                    failures += 1
                    let delay = min(30.0, pow(2, Double(min(failures, 5)))) + Double.random(in: 0...0.5)
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                }
            }
        }
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.generation == attempt else { return }
                await self.refresh()
                if let last = self.lastStreamMessage, Date().timeIntervalSince(last) > 60 { self.connection = .stale }
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
            }
        }
    }

    private func apply(_ snapshot: ScannerSnapshot) {
        stocks = snapshot.stocks
        feed = snapshot.feed
        lastUpdated = snapshot.asOf.flatMap(DateParsing.parse) ?? Date()
        updateConnection()
    }

    private func activeToken(fallback: String) async throws -> String {
        guard usesOAuth else { return fallback }
        guard let configuration = OAuthConfiguration.load() else { throw OAuthError.notConfigured }
        return try await oauth.accessToken(config: configuration)
    }

    static func requiresSignIn(_ error: Error) -> Bool {
        if error as? ServiceError == .unauthorized { return true }
        if let oauth = error as? OAuthError { return !oauth.isRetryable }
        return false
    }

    private func updateConnection() {
        if isSimulated { connection = .preview; return }
        if feed.isLive {
            let eventDate = feed.lastEventAt.flatMap(DateParsing.parse)
            connection = (eventDate.map { Date().timeIntervalSince($0) > 60 } ?? true) ? .stale : .live
        } else if feed.state == "connecting" { connection = .connecting }
        else { connection = .stale }
    }

    private func receive(_ event: StreamEvent, generation attempt: Int) {
        guard attempt == generation, mode == .connected, let data = event.data.data(using: .utf8) else { return }
        let decoder = JSONDecoder()
        lastStreamMessage = Date()
        switch event.name {
        case "snapshot":
            if let snapshot = try? decoder.decode(ScannerSnapshot.self, from: data) { apply(snapshot) }
        case "feed":
            if let next = try? decoder.decode(FeedStatus.self, from: data) { feed = next; updateConnection() }
        case "tick":
            guard let tick = try? decoder.decode(Tick.self, from: data), tick.price.isFinite, tick.price > 0 else { return }
            let dedup = "\(tick.symbol)|\(tick.id ?? "\(tick.time)|\(tick.price)|\(tick.size ?? 0)")"
            guard !recentTickIDs.contains(dedup) else { return }
            recentTickIDs.insert(dedup); recentTickOrder.append(dedup)
            if recentTickOrder.count > 5000 { recentTickIDs.remove(recentTickOrder.removeFirst()) }
            feed.lastEventAt = tick.time
            updateConnection()
            if let index = stocks.firstIndex(where: { $0.symbol == tick.symbol }) {
                let previous = stocks[index]
                let priorClose = previous.price / (1 + previous.changePct / 100)
                stocks[index].price = tick.price
                if priorClose > 0 { stocks[index].changePct = (tick.price / priorClose - 1) * 100 }
                stocks[index].updatedAt = tick.time
            }
            for timeframe in Timeframe.allCases {
                let key = Self.detailKey(tick.symbol, timeframe)
                guard var detail = details[key] else { continue }
                let printID = tick.id ?? dedup
                // The REST seed may already include a print whose SSE frame is delayed.
                guard !detail.trades.contains(where: { $0.id == printID }) else { continue }
                detail.bars = ChartWindow.update(detail.bars, tick: tick, timeframe: timeframe)
                detail.trades.insert(TradePrint(id: printID, time: tick.time, price: tick.price, size: tick.size ?? 0), at: 0)
                detail.trades = Array(detail.trades.sorted { $0.time > $1.time }.prefix(100))
                detail.feed = feed
                details[key] = detail
            }
            error = nil
        default: break
        }
    }
}
