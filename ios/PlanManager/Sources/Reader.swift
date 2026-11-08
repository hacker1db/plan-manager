import SwiftUI
import WebKit

struct Reader: UIViewRepresentable {
    let html: String
    @Environment(\.openURL) private var openURL
    func makeCoordinator() -> Coordinator { Coordinator(open: openURL) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.html != html else { return }
        context.coordinator.html = html
        view.loadHTMLString("""
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>:root{color-scheme:light dark}body{font:-apple-system-body;margin:20px;overflow-wrap:anywhere}pre{overflow:auto;padding:12px;background:rgba(128,128,128,.12)}table{display:block;overflow:auto}a{color:LinkText}h1,h2,h3{font-family:-apple-system}</style></head><body>\(html)</body></html>
        """, baseURL: nil)
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
