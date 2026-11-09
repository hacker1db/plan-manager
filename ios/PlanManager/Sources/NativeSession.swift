import AuthenticationServices
import Foundation
import Observation
import Security
import UIKit
import WorkOS

private struct SessionTokens: Codable {
    let access: String
    let refresh: String
}

@MainActor @Observable final class NativeSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private(set) var signedIn = false
    private(set) var signingIn = false
    private(set) var sessionGeneration = UUID()
    let serviceURL: URL?
    let configured: Bool
    private let clientID: String
    private let redirect: URL?
    private let client: PublicClient
    private var tokens: SessionTokens?
    private var browser: ASWebAuthenticationSession?
    private var refreshTask: Task<SessionTokens, Error>?
    private var generation = 0
    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "PlanManager.WorkOS.Native",
         kSecAttrAccount as String: clientID + "|" + (serviceURL?.absoluteString ?? "")]
    }
    override init() {
        clientID = Bundle.main.object(forInfoDictionaryKey: "WorkOSClientID") as? String ?? ""
        redirect = URL(string: Bundle.main.object(forInfoDictionaryKey: "WorkOSRedirectURI") as? String ?? "")
        serviceURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "PlanServiceURL") as? String ?? "")
        client = PublicClient(clientID: clientID)
        // A registered reverse-domain private scheme is separate from CLI loopback callbacks.
        configured = clientID.hasPrefix("client_") && serviceURL?.scheme == "https" && serviceURL?.host != nil && redirect?.scheme?.contains(".") == true && redirect?.host != nil && redirect?.query == nil && redirect?.fragment == nil
        super.init()
        if configured {
            var query = keychainQuery
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data {
                tokens = try? JSONDecoder().decode(SessionTokens.self, from: data)
                signedIn = tokens != nil
            }
        }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
    func signIn() async throws {
        guard configured, let redirect, !signingIn else { throw APIError.invalidConfiguration }
        signingIn = true
        defer { signingIn = false; browser = nil }
        let epoch = generation
        let authorization = try client.getAuthorizationUrlWithPKCE(redirectUri: redirect.absoluteString, provider: "authkit")
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authorization.url, callbackURLScheme: redirect.scheme) { url, error in
                if let url { continuation.resume(returning: url) }
                else { continuation.resume(throwing: error ?? APIError.signedOut) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            browser = session
            if !session.start() { continuation.resume(throwing: APIError.unavailable) }
        }
        let code = try Self.authorizationCode(callback: callback, redirect: redirect, state: authorization.state)
        let result = try await client.authenticateWithCode(code: code, codeVerifier: authorization.codeVerifier)
        guard epoch == generation else { throw APIError.signedOut }
        try store(SessionTokens(access: result.accessToken, refresh: result.refreshToken))
        signedIn = true
        sessionGeneration = UUID()
    }
    static func authorizationCode(callback: URL, redirect: URL, state: String) throws -> String {
        guard callback.scheme == redirect.scheme, callback.host == redirect.host, callback.path == redirect.path, callback.port == redirect.port, callback.user == nil, callback.password == nil, callback.fragment == nil,
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state,
              !items.contains(where: { $0.name == "error" }),
              items.filter({ $0.name == "code" }).count == 1,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else { throw APIError.signedOut }
        return code
    }
    func token() async throws -> String? {
        guard signedIn, let tokens else { throw APIError.signedOut }
        // Decode expiry only to schedule refresh. Authorization is exclusively server-side.
        if Self.expiresAt(tokens.access).timeIntervalSinceNow > 60 { return tokens.access }
        if let refreshTask {
            let epoch = generation
            let result = try await refreshTask.value
            guard signedIn, epoch == generation else { throw APIError.signedOut }
            return result.access
        }
        let epoch = generation
        let client = client
        let task = Task { let result = try await client.authenticateWithRefreshToken(refreshToken: tokens.refresh); return SessionTokens(access: result.accessToken, refresh: result.refreshToken) }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let result = try await task.value
            guard epoch == generation else { throw APIError.signedOut }
            try store(result)
            return result.access
        } catch {
            // Clear in-memory access on refresh failure. A later sign-in can recover safely.
            try? signOut()
            throw APIError.signedOut
        }
    }
    private static func expiresAt(_ jwt: String) -> Date {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return .distantPast }
        var value = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let data = Data(base64Encoded: value), let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let expiry = payload["exp"] as? Double else { return .distantPast }
        return Date(timeIntervalSince1970: expiry)
    }
    private func store(_ value: SessionTokens) throws {
        let data = try JSONEncoder().encode(value)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(keychainQuery as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            let added = SecItemAdd(keychainQuery.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw APIError.unavailable }
        } else if updated != errSecSuccess { throw APIError.unavailable }
        tokens = value
    }
    func signOut() throws {
        generation += 1
        browser?.cancel(); browser = nil
        refreshTask?.cancel(); refreshTask = nil
        tokens = nil; signedIn = false; sessionGeneration = UUID()
        let result = SecItemDelete(keychainQuery as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw APIError.unavailable }
    }
}
