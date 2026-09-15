import XCTest
@testable import Momentum

final class MomentumTests: XCTestCase {
    func testPackagedPrivacyManifestAndDebugLocalNetworking() {
        XCTAssertNotNil(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any]
        XCTAssertEqual(ats?["NSAllowsLocalNetworking"] as? Bool, true)
        XCTAssertNil(ats?["NSAllowsArbitraryLoads"])
    }
    func testServerURLRejectsCleartextOutsideLoopback() throws {
        XCTAssertThrowsError(try ServerAddress("http://api.example.com"))
        XCTAssertThrowsError(try ServerAddress("http://192.168.1.2:4100"))
        XCTAssertThrowsError(try ServerAddress("http://localhost:4100", allowLocalHTTP: false))
        XCTAssertNoThrow(try ServerAddress("http://localhost:4100", allowLocalHTTP: true))
        XCTAssertNoThrow(try ServerAddress("https://market.example.com"))
    }
    func testServerURLRejectsCredentialOrQueryInjection() {
        for value in ["https://user:secret@market.example.com", "https://market.example.com?token=secret", "https://market.example.com/#token", "https://market.example.com/evil/path", "javascript:alert(1)", ""] {
            XCTAssertThrowsError(try ServerAddress(value), value)
        }
    }
    func testTokenOnlyTravelsInAuthorizationHeader() throws {
        let request = try APIClient.request(base: ServerAddress("https://market.example.com"), token: "test-secret", path: "scanner/NVDA", query: [URLQueryItem(name: "timeframe", value: "1Min")])
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-secret")
        XCTAssertEqual(request.url?.absoluteString, "https://market.example.com/api/v1/scanner/NVDA?timeframe=1Min")
        XCTAssertFalse(request.url!.absoluteString.contains("secret"))
        XCTAssertThrowsError(try APIClient.request(base: ServerAddress("https://market.example.com"), token: "invalid\r\nheader", path: "scanner"))
    }
    func testSSEParsesFramesCommentsAndMultilineData() {
        var parser = SSEParser()
        XCTAssertNil(parser.consume(": heartbeat"))
        XCTAssertNil(parser.consume("event: tick"))
        XCTAssertNil(parser.consume("data: {\"symbol\":\"NVDA\","))
        XCTAssertNil(parser.consume("data: \"price\":100}"))
        XCTAssertEqual(parser.consume(""), StreamEvent(name: "tick", data: "{\"symbol\":\"NVDA\",\n\"price\":100}"))
        XCTAssertNil(parser.consume("data: hello"))
        XCTAssertEqual(parser.consume(""), StreamEvent(name: "message", data: "hello"))
        XCTAssertNil(parser.consume(""))
    }
    func testNumericAndStringTradeIDsDecode() throws {
        for id in ["123", "\"abc\""] {
            let data = Data("{\"id\":\(id),\"time\":\"2026-09-09T13:31:00Z\",\"price\":100.5,\"size\":20}".utf8)
            let trade = try JSONDecoder().decode(TradePrint.self, from: data)
            XCTAssertEqual(trade.price, 100.5)
            XCTAssertEqual(trade.id, id == "123" ? "123" : "abc")
        }
    }
    func testScannerContractWithOptionalIndicators() throws {
        let json = #"{"asOf":"2026-09-09T14:00:00Z","feed":{"state":"live","feed":"iex","lastEventAt":"2026-09-09T14:00:00Z","error":null},"stocks":[{"symbol":"NVDA","price":100.25,"changePct":1.25,"volume":1000,"relativeVolume":null,"score":90,"spreadBps":null,"updatedAt":"2026-09-09T14:00:00Z"}]}"#
        let snapshot = try JSONDecoder().decode(ScannerSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.stocks.first?.symbol, "NVDA")
        XCTAssertTrue(snapshot.feed.isLive)
        XCTAssertNil(snapshot.stocks.first?.relativeVolume)
    }
    func testChartWindowClampsPanAndHandlesEmptyBars() {
        XCTAssertEqual(ChartWindow.range(count: 0, visible: 50, offset: 0), 0..<0)
        XCTAssertEqual(ChartWindow.range(count: 100, visible: 20, offset: 0), 80..<100)
        XCTAssertEqual(ChartWindow.range(count: 100, visible: 20, offset: 999), 0..<20)
        XCTAssertEqual(ChartWindow.range(count: 7, visible: 20, offset: -2), 0..<7)
    }
    func testTickUpdatesCurrentCandleThenAppendsNextInterval() {
        let start = DateParsing.parse("2026-09-09T14:00:00Z")!.timeIntervalSince1970
        let bars = [PriceBar(time: start, open: 100, high: 102, low: 99, close: 101, volume: 100)]
        let current = ChartWindow.update(bars, tick: Tick(symbol: "NVDA", price: 103, size: 20, time: "2026-09-09T14:00:30.123Z", id: "1"), timeframe: .minute)
        XCTAssertEqual(current.count, 1)
        XCTAssertEqual(current[0].high, 103)
        XCTAssertEqual(current[0].open, 100)
        XCTAssertEqual(current[0].volume, 120)
        let next = ChartWindow.update(current, tick: Tick(symbol: "NVDA", price: 104, size: 30, time: "2026-09-09T14:01:01Z", id: "2"), timeframe: .minute)
        XCTAssertEqual(next.count, 2)
        XCTAssertEqual(next[1].time, start + 60)
        XCTAssertEqual(next[1].open, 104)
    }
    func testOutOfOrderOrInvalidTickDoesNotRewriteCandle() {
        let bars = [PriceBar(time: DateParsing.parse("2026-09-09T14:00:00Z")!.timeIntervalSince1970, open: 100, high: 102, low: 99, close: 101, volume: 100)]
        XCTAssertEqual(ChartWindow.update(bars, tick: Tick(symbol: "NVDA", price: 90, size: 10, time: "2026-09-09T13:59:59Z", id: "old"), timeframe: .minute), bars)
        XCTAssertEqual(ChartWindow.update(bars, tick: Tick(symbol: "NVDA", price: .nan, size: 10, time: "2026-09-09T14:00:05Z", id: "bad"), timeframe: .minute), bars)
    }
    func testPreviewNeverClaimsLiveData() {
        for timeframe in Timeframe.allCases {
            let detail = PreviewData.detail("NVDA", timeframe: timeframe)
            XCTAssertEqual(detail.feed.state, "preview")
            XCTAssertFalse(detail.feed.isLive)
            XCTAssertEqual(detail.bars.count, 180)
            XCTAssertEqual(detail.bars[1].time - detail.bars[0].time, timeframe.seconds)
        }
    }
    func testDailyCandleUsesNewYorkSessionBoundaryAcrossDST() {
        for (tickTime, barTime) in [("2026-09-09T14:30:00Z", "2026-09-09T04:00:00Z"), ("2026-01-09T14:30:00Z", "2026-01-09T05:00:00Z")] {
            let bars = [PriceBar(time: DateParsing.parse(barTime)!.timeIntervalSince1970, open: 100, high: 102, low: 99, close: 101, volume: 100)]
            let updated = ChartWindow.update(bars, tick: Tick(symbol: "NVDA", price: 103, size: 10, time: tickTime, id: "daily"), timeframe: .day)
            XCTAssertEqual(updated.count, 1)
            XCTAssertEqual(updated[0].close, 103)
        }
    }
    func testPKCEChallengeMatchesRFC7636TestVector() {
        XCTAssertEqual(PKCE.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    func testPKCEAuthorizationURLHasStateAndS256ButNoVerifier() throws {
        let config = try OAuthConfiguration(issuer: "https://identity.example.com", clientID: "native-public", audience: "momentum-api", redirect: "com.momentumscanner.app://auth/callback")
        let provider = OAuthDiscovery(issuer: "https://identity.example.com", authorizationEndpoint: URL(string: "https://identity.example.com/authorize")!, tokenEndpoint: URL(string: "https://identity.example.com/token")!)
        let url = try PKCE.authorizationURL(config: config, provider: provider, verifier: "never-in-url", state: "random-state")
        let values = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(values.first { $0.name == "code_challenge_method" }?.value, "S256")
        XCTAssertEqual(values.first { $0.name == "state" }?.value, "random-state")
        XCTAssertFalse(url.absoluteString.contains("never-in-url"))
        XCTAssertFalse(url.absoluteString.contains("client_secret"))
    }
    func testOAuthCallbackRejectsMismatchedStateAndDuplicateCodes() throws {
        let config = try OAuthConfiguration(issuer: "https://identity.example.com", clientID: "native", audience: "api", redirect: "com.momentumscanner.app://auth/callback")
        XCTAssertEqual(try PKCE.code(from: URL(string: "com.momentumscanner.app://auth/callback?state=expected&code=valid")!, config: config, state: "expected"), "valid")
        for suffix in ["state=attacker&code=valid", "state=expected&code=a&code=b", "state=expected&code=a&error=denied", "state=expected&state=expected&code=a"] {
            XCTAssertThrowsError(try PKCE.code(from: URL(string: "com.momentumscanner.app://auth/callback?\(suffix)")!, config: config, state: "expected"))
        }
        XCTAssertThrowsError(try PKCE.code(from: URL(string: "attacker://auth/callback?state=expected&code=a")!, config: config, state: "expected"))
    }
    func testOAuthDiscoveryRejectsIssuerMismatchAndHTTPTokenEndpoint() throws {
        let config = try OAuthConfiguration(issuer: "https://identity.example.com", clientID: "native", audience: "api", redirect: "com.momentumscanner.app://auth/callback")
        let good = OAuthDiscovery(issuer: "https://identity.example.com/", authorizationEndpoint: URL(string: "https://identity.example.com/authorize")!, tokenEndpoint: URL(string: "https://identity.example.com/token")!)
        XCTAssertNoThrow(try good.validate(for: config))
        var bad = good; bad.issuer = "https://attacker.example.com"
        XCTAssertThrowsError(try bad.validate(for: config))
        bad = good; bad.tokenEndpoint = URL(string: "http://identity.example.com/token")!
        XCTAssertThrowsError(try bad.validate(for: config))
    }
    func testOAuthFormPercentEncodesSpecialCharacters() {
        let form = String(decoding: PKCE.formBody(["code": "a+b&c=d value"]), as: UTF8.self)
        XCTAssertEqual(form, "code=a%2Bb%26c%3Dd%20value")
    }
    func testKeychainRoundtripAndErase() throws {
        let vault = TokenVault(service: "com.momentum.tests.\(UUID().uuidString)")
        defer { try? vault.clear() }
        XCTAssertNil(try vault.read())
        try vault.save("first-secret")
        XCTAssertEqual(try vault.read(), "first-secret")
        try vault.save("replacement-secret")
        XCTAssertEqual(try vault.read(), "replacement-secret")
        try vault.clear()
        XCTAssertNil(try vault.read())
    }
    func testOAuthTransientHTTPClassificationPreservesRetryPolicy() async {
        for status in [408, 429, 500, 502, 503, 504] {
            XCTAssertTrue(OAuthClient.isTransientHTTP(status))
            let requiresSignIn = await MarketStore.requiresSignIn(OAuthError.temporarilyUnavailable(status))
            XCTAssertFalse(requiresSignIn)
        }
        XCTAssertFalse(OAuthClient.isTransientHTTP(400))
        XCTAssertFalse(OAuthClient.isTransientHTTP(401))
        let revoked = await MarketStore.requiresSignIn(OAuthError.invalidGrant)
        XCTAssertTrue(revoked)
    }
    func testTransientRefreshPreservesAndLaterRotatesCredentials() async throws {
        for status in [429, 503] {
            let vault = TokenVault(service: "com.momentum.tests.refresh.\(UUID().uuidString)")
            defer { try? vault.clear() }
            let config = try OAuthStub.configuration()
            let original = OAuthTokens(accessToken: "expired-test-access", refreshToken: "current-test-refresh", expiresAt: Date().addingTimeInterval(-5), issuer: config.issuer.absoluteString, clientID: config.clientID, audience: config.audience)
            try vault.save(String(decoding: JSONEncoder().encode(original), as: UTF8.self))
            let originalValue = try vault.read()
            let client = OAuthClient(vault: vault, configuration: OAuthStub.networkConfiguration())
            OAuthStub.respond(tokenStatus: status, tokenBody: #"{"error":"temporarily_unavailable"}"#)
            do { _ = try await client.accessToken(config: config); XCTFail("Expected temporary provider failure") }
            catch { XCTAssertEqual(error as? OAuthError, .temporarilyUnavailable(status)) }
            XCTAssertEqual(try vault.read(), originalValue, "Transient failures must not delete or replace the current refresh token")
            OAuthStub.respond(tokenStatus: 200, tokenBody: OAuthStub.success)
            let token = try await client.accessToken(config: config)
            XCTAssertEqual(token, "new-test-access")
            let stored = try JSONDecoder().decode(OAuthTokens.self, from: Data(XCTUnwrap(vault.read()).utf8))
            XCTAssertEqual(stored.refreshToken, "rotated-test-refresh")
        }
    }
    func testInvalidGrantErasesRevokedSession() async throws {
        let vault = TokenVault(service: "com.momentum.tests.revocation.\(UUID().uuidString)")
        defer { try? vault.clear() }
        let config = try OAuthStub.configuration()
        let tokens = OAuthTokens(accessToken: "expired-test-access", refreshToken: "revoked-test-refresh", expiresAt: Date().addingTimeInterval(-5), issuer: config.issuer.absoluteString, clientID: config.clientID, audience: config.audience)
        try vault.save(String(decoding: JSONEncoder().encode(tokens), as: UTF8.self))
        let client = OAuthClient(vault: vault, configuration: OAuthStub.networkConfiguration())
        OAuthStub.respond(tokenStatus: 400, tokenBody: #"{"error":"invalid_grant"}"#)
        do { _ = try await client.accessToken(config: config); XCTFail("Expected revoked session") }
        catch { XCTAssertEqual(error as? OAuthError, .invalidGrant) }
        XCTAssertNil(try vault.read())
        let stillSaved = await client.hasSavedSession()
        XCTAssertFalse(stillSaved)
    }
    func testEntitlementRejectionErasesNewlyStoredSignIn() async throws {
        let vault = TokenVault(service: "com.momentum.tests.entitlement.\(UUID().uuidString)")
        defer { try? vault.clear() }
        let client = OAuthClient(vault: vault, configuration: OAuthStub.networkConfiguration())
        OAuthStub.respond(tokenStatus: 200, tokenBody: OAuthStub.success)
        let tokens = try await client.exchange(code: "test-code", verifier: "test-verifier", config: OAuthStub.configuration(), provider: OAuthStub.provider())
        XCTAssertNotNil(try vault.read())
        do {
            try await client.validateSession(accessToken: tokens.accessToken) { _ in throw ServiceError.unauthorized }
            XCTFail("Expected entitlement rejection")
        } catch { XCTAssertEqual(error as? ServiceError, .unauthorized) }
        XCTAssertNil(try vault.read())
        let stillSaved = await client.hasSavedSession()
        XCTAssertFalse(stillSaved)
    }
    func testTemporarySessionValidationFailurePreservesNewCredentials() async throws {
        let vault = TokenVault(service: "com.momentum.tests.session-outage.\(UUID().uuidString)")
        defer { try? vault.clear() }
        let client = OAuthClient(vault: vault, configuration: OAuthStub.networkConfiguration())
        OAuthStub.respond(tokenStatus: 200, tokenBody: OAuthStub.success)
        let tokens = try await client.exchange(code: "test-code", verifier: "test-verifier", config: OAuthStub.configuration(), provider: OAuthStub.provider())
        let original = try vault.read()
        do {
            try await client.validateSession(accessToken: tokens.accessToken) { _ in throw ServiceError.http(503) }
            XCTFail("Expected temporary API outage")
        } catch { XCTAssertEqual(error as? ServiceError, .http(503)) }
        XCTAssertEqual(try vault.read(), original)
        let stillSaved = await client.hasSavedSession()
        XCTAssertTrue(stillSaved, "The UI can expose local sign-out even though API validation could not finish")
    }
}

/// All identity-provider traffic in these tests terminates in this URLProtocol.
/// Only dummy fixture credentials are used; no identity provider is contacted.
private final class OAuthStub: URLProtocol {
    private static let lock = NSLock()
    private static var handler: ((URLRequest) -> (Int, String))?
    static let success = #"{"access_token":"new-test-access","refresh_token":"rotated-test-refresh","expires_in":3600,"token_type":"Bearer"}"#
    static func configuration() throws -> OAuthConfiguration {
        try OAuthConfiguration(issuer: "https://identity.example.invalid", clientID: "native-test", audience: "test-api", redirect: "com.momentumscanner.app://auth/callback")
    }
    static func provider() -> OAuthDiscovery {
        OAuthDiscovery(issuer: "https://identity.example.invalid", authorizationEndpoint: URL(string: "https://identity.example.invalid/authorize")!, tokenEndpoint: URL(string: "https://identity.example.invalid/token")!)
    }
    static func networkConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OAuthStub.self]
        return configuration
    }
    static func respond(tokenStatus: Int, tokenBody: String) {
        lock.lock(); defer { lock.unlock() }
        handler = { request in
            if request.url!.path.contains("openid-configuration") {
                return (200, #"{"issuer":"https://identity.example.invalid","authorization_endpoint":"https://identity.example.invalid/authorize","token_endpoint":"https://identity.example.invalid/token"}"#)
            }
            return (tokenStatus, tokenBody)
        }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let responder = Self.handler; Self.lock.unlock()
        guard let responder, let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return }
        let (status, body) = responder(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
