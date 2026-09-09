import Foundation

struct StreamEvent: Equatable {
    var name: String
    var data: String
}

/// An SSE frame may have comments, several data lines, or an omitted event name.
struct SSEParser {
    private var name = "message"
    private var data: [String] = []
    mutating func consume(_ line: String) -> StreamEvent? {
        if line.isEmpty {
            defer { name = "message"; data.removeAll(keepingCapacity: true) }
            return data.isEmpty ? nil : StreamEvent(name: name, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard let field = parts.first else { return nil }
        var value = parts.count > 1 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch field {
        case "event": name = value
        case "data": data.append(value)
        default: break
        }
        return nil
    }
}

actor APIClient {
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 25
        config.timeoutIntervalForResource = 86_400
        session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }
    static func request(base: ServerAddress, token: String, path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanToken.isEmpty, cleanToken.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }) else { throw ServiceError.tokenMissing }
        var parts = URLComponents(url: base.url, resolvingAgainstBaseURL: false)!
        parts.path = "/api/v1/" + path
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url else { throw ServiceError.invalidURL }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(cleanToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw ServiceError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 403 { throw ServiceError.unauthorized }
        guard (200...299).contains(http.statusCode) else { throw ServiceError.http(http.statusCode) }
    }
    func checkSession(base: ServerAddress, token: String) async throws {
        let (data, response) = try await session.data(for: Self.request(base: base, token: token, path: "session"))
        try validate(response)
        struct SessionResponse: Decodable { var authenticated: Bool }
        guard try JSONDecoder().decode(SessionResponse.self, from: data).authenticated else { throw ServiceError.unauthorized }
    }
    func scanner(base: ServerAddress, token: String) async throws -> ScannerSnapshot {
        let (data, response) = try await session.data(for: Self.request(base: base, token: token, path: "scanner"))
        try validate(response)
        return try JSONDecoder().decode(ScannerSnapshot.self, from: data)
    }
    func detail(symbol: String, timeframe: Timeframe, base: ServerAddress, token: String) async throws -> StockDetail {
        let (data, response) = try await session.data(for: Self.request(base: base, token: token, path: "scanner/\(symbol)", query: [URLQueryItem(name: "timeframe", value: timeframe.rawValue)]))
        try validate(response)
        return try JSONDecoder().decode(StockDetail.self, from: data)
    }
    func stream(base: ServerAddress, token: String, receive: @escaping @Sendable (StreamEvent) async -> Void) async throws {
        var request = try Self.request(base: base, token: token, path: "events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 75
        let (bytes, response) = try await session.bytes(for: request)
        try validate(response)
        var parser = SSEParser()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if let event = parser.consume(line) { await receive(event) }
        }
        try Task.checkCancellation()
        throw URLError(.networkConnectionLost)
    }
}
