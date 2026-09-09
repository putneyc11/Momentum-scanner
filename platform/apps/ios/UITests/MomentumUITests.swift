import XCTest

final class MomentumUITests: XCTestCase {
    func testNativeScannerDetailTimeframesTapeAndWatchlist() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--preview"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Follow the momentum."].waitForExistence(timeout: 10))
        let scanner = XCTAttachment(screenshot: app.screenshot())
        scanner.name = "01-Native-Scanner-Preview"
        scanner.lifetime = .keepAlways
        add(scanner)
        let row = app.buttons["stock-row-NVDA"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(app.segmentedControls.buttons["5m"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["5m"].tap()
        XCTAssertTrue(app.buttons["Zoom in"].waitForExistence(timeout: 5))
        app.buttons["Zoom in"].tap()
        app.buttons["Zoom out"].tap()
        let detail = XCTAttachment(screenshot: app.screenshot())
        detail.name = "02-Native-Detail-Preview"
        detail.lifetime = .keepAlways
        add(detail)
        app.swipeUp()
        XCTAssertTrue(app.segmentedControls.buttons["Time & Sales"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["Time & Sales"].tap()
        XCTAssertTrue(app.staticTexts["Last 100 prints"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["TIME · DEVICE LOCAL"].exists)
        let tape = XCTAttachment(screenshot: app.screenshot())
        tape.name = "03-Native-Time-and-Sales-Preview"
        tape.lifetime = .keepAlways
        add(tape)
        app.tabBars.buttons["Watchlist"].tap()
        XCTAssertTrue(app.staticTexts["Keep your edge."].waitForExistence(timeout: 5))
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Preview mode uses simulated, frozen data."].waitForExistence(timeout: 5))
    }
}
