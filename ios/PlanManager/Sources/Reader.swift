import SwiftUI
import WebKit

struct Reader: UIViewRepresentable {
    let html: String

    // The web dashboard stylesheet (src/dashboard/style.css), bundled as a resource so the reader cannot drift from the web.
    static let stylesheet = Bundle.main.url(forResource: "style", withExtension: "css").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""

    /// Builds the same markup plan.js renders (hero, metadata strip, document sheet) around the server-rendered HTML.
    static func page(_ document: Document, stylesheet: String = stylesheet) -> String {
        let plan = document.plan
        let status = ["active", "completed", "archived"].contains(plan.status) ? plan.status : "unknown"
        let tags = plan.tags.isEmpty ? "—" : plan.tags.map { "<span class=\"plan-tag\">\(escape($0))</span>" }.joined()
        return """
        <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>\(stylesheet.replacingOccurrences(of: "</", with: "<\\/"))
        body{background:transparent;min-height:0;-webkit-text-size-adjust:100%}
        </style></head><body><main class="shell" style="display:block;padding-top:0">
        <header class="hero detail-hero"><p class="eyebrow">Plan record</p><h1>\(escape(plan.title))</h1></header>
        <div class="metadata">
        <div class="meta is-\(status)"><span class="meta-label">Status</span><span class="meta-value"><span class="status-badge \(status)">\(escape(plan.status))</span></span></div>
        <div class="meta"><span class="meta-label">Updated</span><span class="meta-value"><time>\(escape(Theme.date(plan.updated)))</time></span></div>
        <div class="meta"><span class="meta-label">Tags</span><span class="meta-value"><span class="plan-meta">\(tags)</span></span></div>
        <div class="meta"><span class="meta-label">Revision</span><span class="meta-value"><span class="rev">\(escape(String(plan.revision.prefix(8))))</span></span></div>
        </div>
        <div class="document"><article class="markdown-body">\(document.html)</article></div>
        </main></body></html>
        """
    }

    static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
    }

    @Environment(\.openURL) private var openURL
    func makeCoordinator() -> Coordinator { Coordinator(open: openURL) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.contentInsetAdjustmentBehavior = .automatic
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.html != html else { return }
        context.coordinator.html = html
        view.loadHTMLString(html, baseURL: nil)
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { view.stopLoading(); view.loadHTMLString("", baseURL: nil); view.navigationDelegate = nil }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        var html: String?
        let open: OpenURLAction
        init(open: OpenURLAction) { self.open = open }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated {
                if let url = navigationAction.request.url, ["https", "http", "mailto"].contains(url.scheme ?? "") { open(url) }
                decisionHandler(.cancel)
            } else { decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel) }
        }
    }
}
