import Foundation

struct Plan: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let status: String
    let tags: [String]
    let created: String
    let updated: String
    let revision: String
}
struct Library: Decodable, Sendable { let plans: [Plan]; let nextOffset: Int? }
struct Heading: Decodable, Identifiable, Sendable { let id: String; let path: [String]; let title: String; let fingerprint: String }
struct Document: Decodable, Sendable {
    let plan: Plan
    let html: String
    let statusUnavailableReason: String?
    var headings: [Heading]? = nil
}
enum APIError: Error, LocalizedError {
    case signedOut, forbidden, notFound, conflict, unavailable, invalidConfiguration, transport
    var errorDescription: String? {
        switch self {
        case .signedOut: "Your session expired. Sign in again."
        case .forbidden: "This account cannot access the owner's library."
        case .notFound: "This plan is no longer available."
        case .conflict: "The plan changed. Refresh and review it before retrying."
        case .unavailable: "The service could not complete this request. Try again."
        case .invalidConfiguration: "Configure the shared WorkOS environment and HTTPS development service."
        case .transport: "Unable to connect. Check your connection and retry."
        }
    }
}
@MainActor protocol PlanRepository {
    func library() async throws -> [Plan]
    func document(_ id: String) async throws -> Document
    func status(_ plan: Plan, to status: String) async throws -> Plan
}
@MainActor final class APIRepository: NSObject, PlanRepository, URLSessionTaskDelegate {
    let base: URL
    let token: @MainActor () async throws -> String?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    init(base: URL, token: @escaping @MainActor () async throws -> String?) { self.base = base; self.token = token }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
    private func request<T: Decodable>(_ path: String, body: Data? = nil, query: [URLQueryItem] = []) async throws -> T {
        guard base.scheme == "https", base.host != nil, base.user == nil, base.password == nil else { throw APIError.invalidConfiguration }
        guard let jwt = try await token() else { throw APIError.signedOut }
        var components = URLComponents(url: base.appendingPathComponent("api/v1/plans").appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpMethod = "POST"; request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw APIError.transport }
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: return try JSONDecoder().decode(T.self, from: data)
        case 401: throw APIError.signedOut
        case 403: throw APIError.forbidden
        case 404: throw APIError.notFound
        case 409: throw APIError.conflict
        default: throw APIError.unavailable
        }
    }
    func library() async throws -> [Plan] {
        var plans: [Plan] = []
        var offset = 0
        repeat {
            try Task.checkCancellation()
            let page: Library = try await request("", query: [URLQueryItem(name: "limit", value: "100"), URLQueryItem(name: "offset", value: String(offset))])
            plans.append(contentsOf: page.plans)
            guard let next = page.nextOffset else { return Array(Dictionary(plans.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest }).values).sorted { $0.updated > $1.updated } }
            guard next > offset else { throw APIError.unavailable }
            offset = next
        } while offset < 100_000
        throw APIError.unavailable
    }
    func document(_ id: String) async throws -> Document { try await request("\(id)/render") }
    func status(_ plan: Plan, to status: String) async throws -> Plan {
        try await request("\(plan.id)/status", body: JSONEncoder().encode(["status": status, "expectedRevision": plan.revision]))
    }
}
@MainActor final class FixtureRepository: PlanRepository {
    static let plan = Plan(id: "fixture_plan", title: "Review the mobile app", status: "active", tags: ["SwiftUI"], created: "2026-11-07", updated: "2026-11-07", revision: String(repeating: "a", count: 64))
    private var current = plan
    func library() async throws -> [Plan] { [current] }
    func document(_ id: String) async throws -> Document {
        Document(plan: current, html: "<h1>Mobile review</h1><p>This is fixture data. No hosted library is connected.</p><h2>Validation</h2><ul><li>Read on iPhone and iPad</li><li>Review before changing status</li></ul><pre><code>graph TD; Read--&gt;Review</code></pre>", statusUnavailableReason: nil)
    }
    func status(_ plan: Plan, to status: String) async throws -> Plan {
        guard plan.revision == current.revision else { throw APIError.conflict }
        current = Plan(id: plan.id, title: plan.title, status: status, tags: plan.tags, created: plan.created, updated: plan.updated, revision: UUID().uuidString)
        return current
    }
}
