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
    @MainActor func testReaderPageEscapesMetadataAndUsesWebStylesheet() throws {
        XCTAssertTrue(Reader.stylesheet.contains("--term-aqua: #04d1f9"), "src/dashboard/style.css must be bundled")
        let plan = Plan(id: "p", title: "<img src=x onerror=alert(1)>", status: "\"><script>", tags: ["<b>"], created: "2026-11-07", updated: "2026-11-07", revision: String(repeating: "a", count: 64))
        let page = Reader.page(Document(plan: plan, html: "<p>body</p>", statusUnavailableReason: nil), stylesheet: "x</style><i>")
        XCTAssertFalse(page.contains("<img"))
        XCTAssertFalse(page.contains("<script>"))
        XCTAssertFalse(page.contains("<b>"))
        XCTAssertFalse(page.contains("</style><i>"), "a stylesheet must not close its own <style> element")
        XCTAssertTrue(page.contains("class=\"meta is-unknown\""))
        XCTAssertTrue(page.contains("<article class=\"markdown-body\"><p>body</p></article>"))
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
