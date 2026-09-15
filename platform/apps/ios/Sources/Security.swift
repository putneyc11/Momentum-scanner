import Foundation
import Security

enum ServiceError: LocalizedError, Equatable {
    case invalidURL, tokenMissing, unauthorized, http(Int), invalidResponse, keychain(OSStatus)
    var errorDescription: String? {
        switch self {
        case .invalidURL: "Use an HTTPS server address, such as https://your-service.onrender.com. Do not include a path, password, or query."
        case .tokenMissing: "Enter your app access token in Settings. Never enter an Alpaca API key here."
        case .unauthorized: "Your app access token was rejected. Check it in Settings and connect again."
        case .http(let status): "The server returned HTTP \(status). Try again or check server health."
        case .invalidResponse: "The server returned an unexpected response."
        case .keychain(let status): "Secure storage is unavailable (\(status)). Unlock this device and try again."
        }
    }
}

struct ServerAddress: Equatable {
    let url: URL
    init(_ text: String, allowLocalHTTP: Bool = ServerAddress.debugLocalHTTP) throws {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              let url = parts.url,
              parts.scheme?.lowercased() == "https" || (allowLocalHTTP && parts.scheme?.lowercased() == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased()))
        else { throw ServiceError.invalidURL }
        self.url = url
    }
    static var debugLocalHTTP: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }
}

struct TokenVault {
    let service: String
    init(service: String = "com.momentum.scanner.access-token") { self.service = service }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "app-access"]
    }
    func read() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else { throw ServiceError.keychain(status) }
        return token
    }
    func save(_ token: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if result == errSecItemNotFound {
            let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard status == errSecSuccess else { throw ServiceError.keychain(status) }
        } else if result != errSecSuccess { throw ServiceError.keychain(result) }
    }
    func clear() throws {
        let result = SecItemDelete(query as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw ServiceError.keychain(result) }
    }
}

/// Reject all redirects to prevent bearer tokens being forwarded to another host.
final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
