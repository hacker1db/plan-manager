import XCTest
@testable import PlanManager

final class PlanManagerTests: XCTestCase {
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
