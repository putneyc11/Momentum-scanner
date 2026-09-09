import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

enum OAuthError: LocalizedError, Equatable {
    case notConfigured, invalidProvider, invalidCallback, cancelled, rejected, invalidGrant, sessionExpired, randomFailure
    case temporarilyUnavailable(Int)
    var isRetryable: Bool {
        if case .temporarilyUnavailable = self { return true }
        return false
    }
    var errorDescription: String? {
        switch self {
        case .notConfigured: "Consumer sign-in is not configured in this development build. Set the public OIDC build settings before distribution."
        case .invalidProvider: "The sign-in provider configuration could not be verified."
        case .invalidCallback: "The sign-in response could not be verified. Please sign in again."
        case .cancelled: "Sign-in was cancelled."
        case .rejected: "Sign-in could not be completed. Check your account access and try again."
        case .invalidGrant: "Your session was revoked or expired. Please sign in again."
        case .sessionExpired: "Your sign-in has expired. Please sign in again."
        case .randomFailure: "Secure sign-in could not be initialized. Please try again."
        case .temporarilyUnavailable: "Your sign-in provider is temporarily unavailable. Try again shortly."
        }
    }
}

struct OAuthConfiguration: Equatable {
    let issuer: URL
    let clientID: String
    let audience: String
    let redirect: URL
    static func load(bundle: Bundle = .main) -> OAuthConfiguration? {
        let issuer = bundle.object(forInfoDictionaryKey: "OIDCIssuer") as? String ?? ""
        let client = bundle.object(forInfoDictionaryKey: "OIDCClientID") as? String ?? ""
        let audience = bundle.object(forInfoDictionaryKey: "OIDCAudience") as? String ?? ""
        let redirect = bundle.object(forInfoDictionaryKey: "OIDCRedirectURI") as? String ?? ""
        return try? OAuthConfiguration(issuer: issuer, clientID: client, audience: audience, redirect: redirect)
    }
    init(issuer: String, clientID: String, audience: String, redirect: String) throws {
        guard let issuerURL = URL(string: issuer), issuerURL.scheme == "https", issuerURL.host != nil,
              issuerURL.user == nil, issuerURL.password == nil, issuerURL.query == nil, issuerURL.fragment == nil,
              !clientID.isEmpty, !clientID.contains("$("), !audience.isEmpty, !audience.contains("$("),
              let callback = URL(string: redirect), callback.scheme == "com.momentumscanner.app", callback.host == "auth", callback.path == "/callback", callback.query == nil, callback.fragment == nil
        else { throw OAuthError.notConfigured }
        self.issuer = issuerURL; self.clientID = clientID; self.audience = audience; self.redirect = callback
    }
}

struct OAuthDiscovery: Decodable {
    var issuer: String
    var authorizationEndpoint: URL
    var tokenEndpoint: URL
    enum CodingKeys: String, CodingKey {
        case issuer
        case authorizationEndpoint = "authorization_endpoint"
        case tokenEndpoint = "token_endpoint"
    }
    func validate(for config: OAuthConfiguration) throws {
        let trim = CharacterSet(charactersIn: "/")
        guard issuer.trimmingCharacters(in: trim) == config.issuer.absoluteString.trimmingCharacters(in: trim) else { throw OAuthError.invalidProvider }
        for endpoint in [authorizationEndpoint, tokenEndpoint] {
            guard endpoint.scheme == "https", endpoint.host != nil, endpoint.user == nil, endpoint.password == nil, endpoint.fragment == nil else { throw OAuthError.invalidProvider }
        }
    }
}

struct OAuthTokens: Codable {
    var accessToken: String
    var refreshToken: String?
    var expiresAt: Date
    var issuer: String
    var clientID: String
    var audience: String
}

struct OAuthTokenResponse: Decodable {
    var accessToken: String
    var refreshToken: String?
    var expiresIn: Double
    var tokenType: String
    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", tokenType = "token_type"
    }
}

enum PKCE {
    static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw OAuthError.randomFailure }
        return base64url(Data(bytes))
    }
    static func challenge(_ verifier: String) -> String { base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    static func base64url(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func authorizationURL(config: OAuthConfiguration, provider: OAuthDiscovery, verifier: String, state: String) throws -> URL {
        var parts = URLComponents(url: provider.authorizationEndpoint, resolvingAgainstBaseURL: false)!
        parts.queryItems = [
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: config.clientID),
            URLQueryItem(name: "redirect_uri", value: config.redirect.absoluteString), URLQueryItem(name: "scope", value: "openid profile offline_access"),
            URLQueryItem(name: "audience", value: config.audience), URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge(verifier)), URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        guard let url = parts.url else { throw OAuthError.invalidProvider }
        return url
    }
    static func code(from callback: URL, config: OAuthConfiguration, state: String) throws -> String {
        guard callback.scheme == config.redirect.scheme, callback.host == config.redirect.host, callback.path == config.redirect.path,
              callback.fragment == nil, callback.user == nil, callback.password == nil,
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              items.filter({ $0.name == "state" }).count == 1, items.first(where: { $0.name == "state" })?.value == state,
              items.first(where: { $0.name == "error" }) == nil,
              items.filter({ $0.name == "code" }).count == 1, let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty
        else { throw OAuthError.invalidCallback }
        return code
    }
    static func formBody(_ values: [String: String]) -> Data {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return Data(values.sorted { $0.key < $1.key }.map { key, value in
            "\(key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\(value.addingPercentEncoding(withAllowedCharacters: allowed)!)"
        }.joined(separator: "&").utf8)
    }
}

actor OAuthClient {
    private let vault: TokenVault
    private let session: URLSession
    private var renewal: Task<OAuthTokens, Error>?
    private var generation = 0
    init(vault: TokenVault = TokenVault(service: "com.momentumscanner.app.oauth-session"), configuration supplied: URLSessionConfiguration? = nil) {
        self.vault = vault
        let configuration = supplied ?? URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.timeoutIntervalForRequest = 25
        session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }
    func hasSavedSession() -> Bool { (try? vault.read()) != nil }
    func discovery(_ config: OAuthConfiguration) async throws -> OAuthDiscovery {
        let url = config.issuer.appendingPathComponent(".well-known/openid-configuration")
        let (data, response) = try await session.data(from: url)
        if let status = (response as? HTTPURLResponse)?.statusCode, Self.isTransientHTTP(status) { throw OAuthError.temporarilyUnavailable(status) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw OAuthError.invalidProvider }
        let provider = try JSONDecoder().decode(OAuthDiscovery.self, from: data)
        try provider.validate(for: config)
        return provider
    }
    func exchange(code: String, verifier: String, config: OAuthConfiguration, provider: OAuthDiscovery) async throws -> OAuthTokens {
        let attempt = generation
        let tokens = try await requestTokens(endpoint: provider.tokenEndpoint, fields: ["grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": config.clientID, "redirect_uri": config.redirect.absoluteString], config: config, priorRefresh: nil)
        guard attempt == generation else { throw OAuthError.sessionExpired }
        try save(tokens)
        return tokens
    }
    func accessToken(config: OAuthConfiguration) async throws -> String {
        let attempt = generation
        guard let raw = try vault.read(), let data = raw.data(using: .utf8), let tokens = try? JSONDecoder().decode(OAuthTokens.self, from: data),
              tokens.issuer == config.issuer.absoluteString, tokens.clientID == config.clientID, tokens.audience == config.audience
        else { throw OAuthError.sessionExpired }
        if tokens.expiresAt.timeIntervalSinceNow > 90 { return tokens.accessToken }
        if let renewal { return try await renewal.value.accessToken }
        guard let refresh = tokens.refreshToken else { try clear(); throw OAuthError.sessionExpired }
        let task = Task {
            let provider = try await discovery(config)
            return try await requestTokens(endpoint: provider.tokenEndpoint, fields: ["grant_type": "refresh_token", "refresh_token": refresh, "client_id": config.clientID], config: config, priorRefresh: refresh)
        }
        renewal = task
        defer { renewal = nil }
        do {
            let updated = try await task.value
            guard attempt == generation else { throw OAuthError.sessionExpired }
            try save(updated)
            return updated.accessToken
        } catch {
            if error as? OAuthError == .invalidGrant, attempt == generation { try clear() }
            throw error
        }
    }
    /// Provider sign-in alone does not establish entitlement to this API. Erase a
    /// rejected session, but retain rotated tokens through temporary API outages.
    func validateSession(accessToken: String, check: @escaping @Sendable (String) async throws -> Void) async throws {
        let attempt = generation
        do { try await check(accessToken) }
        catch {
            if error as? ServiceError == .unauthorized, attempt == generation { try clear() }
            throw error
        }
    }
    func clear() throws { generation += 1; renewal?.cancel(); renewal = nil; try vault.clear() }
    private func save(_ tokens: OAuthTokens) throws {
        try vault.save(String(decoding: JSONEncoder().encode(tokens), as: UTF8.self))
    }
    private func requestTokens(endpoint: URL, fields: [String: String], config: OAuthConfiguration, priorRefresh: String?) async throws -> OAuthTokens {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = PKCE.formBody(fields)
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw OAuthError.invalidProvider }
        if Self.isTransientHTTP(status) { throw OAuthError.temporarilyUnavailable(status) }
        guard status == 200 else {
            struct Rejection: Decodable { let error: String }
            if (try? JSONDecoder().decode(Rejection.self, from: data).error) == "invalid_grant" { throw OAuthError.invalidGrant }
            throw OAuthError.rejected
        }
        let result = try JSONDecoder().decode(OAuthTokenResponse.self, from: data)
        guard result.tokenType.lowercased() == "bearer", !result.accessToken.isEmpty, result.expiresIn.isFinite, result.expiresIn > 0 else { throw OAuthError.rejected }
        // Identity is not derived from an unverified ID token. The API validates the
        // access JWT's signature, issuer, audience, expiry and scanner entitlement.
        return OAuthTokens(accessToken: result.accessToken, refreshToken: result.refreshToken ?? priorRefresh, expiresAt: Date().addingTimeInterval(result.expiresIn), issuer: config.issuer.absoluteString, clientID: config.clientID, audience: config.audience)
    }
    static func isTransientHTTP(_ status: Int) -> Bool { status == 408 || status == 429 || (500...599).contains(status) }
}

@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    func authorize(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callback, error in
                Task { @MainActor in self?.session = nil }
                if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: error.map { _ in OAuthError.cancelled } ?? OAuthError.invalidCallback) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            if !session.start() { self.session = nil; continuation.resume(throwing: OAuthError.cancelled) }
        }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
