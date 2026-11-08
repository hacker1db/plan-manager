import XCTest
@testable import PlanManager

final class PlanManagerTests: XCTestCase {
    @MainActor func testCallbackRejectsStateAndDestinationMismatch() throws {
        let redirect = URL(string: "dev.example.planmanager://auth/callback")!
        XCTAssertEqual(try NativeSession.authorizationCode(callback: URL(string: "dev.example.planmanager://auth/callback?state=expected&code=one")!, redirect: redirect, state: "expected"), "one")
        for url in ["dev.example.planmanager://auth/callback?state=wrong&code=one", "dev.other://auth/callback?state=expected&code=one", "dev.example.planmanager://auth/callback?state=expected&code=one&code=two"] {
            XCTAssertThrowsError(try NativeSession.authorizationCode(callback: URL(string: url)!, redirect: redirect, state: "expected"))
        }
    }
    @MainActor func testStaleFixtureCannotOverwriteNewStatus() async throws {
        let repository = FixtureRepository()
        let old = try await repository.library()[0]
        let changed = try await repository.status(old, to: "completed")
        XCTAssertNotEqual(old.revision, changed.revision)
        do { _ = try await repository.status(old, to: "archived"); XCTFail("Expected conflict") } catch APIError.conflict { }
        let current = try await repository.library()[0]
        XCTAssertEqual(current.status, "completed")
    }
}
