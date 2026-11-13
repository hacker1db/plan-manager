import { useEffect, useMemo, useRef } from "react"
import { Linking, StyleSheet } from "react-native"
import { WebView } from "react-native-webview"
import { ANNOTATOR_CSS, ANNOTATOR_SCRIPT, parseAnnotatorMessage, setAnnotationsScript, type AnnotatorMessage } from "../lib/annotator"
import { shouldLoadInReader } from "../lib/reader-policy"
import { colors } from "../theme"
import { readerCss } from "../theme/web-theme.generated"

// The server renders plan HTML with a non-executing renderer, and the reader still treats it as
// untrusted. The CSP blocks every script, network subresource and form in the plan HTML. The only
// script that runs is the app's own annotator, injected natively (exempt from page CSP), and only
// when annotation is enabled. Links leave the app.
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"

// The web app's own .markdown-body / pm-* rules (generated from src/dashboard/style.css), on the
// `.document` panel surface, so plans render exactly as they do on the hosted site.
const PAGE_CSS = `${readerCss}html{font-size:16px;-webkit-text-size-adjust:100%;background:${colors.panelSolid}}body{min-height:100vh;padding:22px 16px 48px;color:var(--text);font-family:var(--body);line-height:1.62;overflow-wrap:anywhere;background:${colors.panelSolid}}`

export function readerDocument(html: string, annotating = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${PAGE_CSS}${annotating ? ANNOTATOR_CSS : ""}</style></head><body><article class="markdown-body">${html}</article></body></html>`
}

type ReaderAnnotation = { key: number; quote: string; note: string }

type Props = {
  html: string
  /** When provided, shows a + beside each block and draws these comments inline. */
  annotations?: readonly ReaderAnnotation[]
  onAnnotatorMessage?(message: AnnotatorMessage): void
}

export function Reader({ html, annotations, onAnnotatorMessage }: Props) {
  const annotating = annotations !== undefined
  // WebView<P = undefined> types its props as WebViewProps & P, so the default P would make them never.
  const view = useRef<WebView<object>>(null)
  const ready = useRef(false)
  const source = useMemo(() => ({ html: readerDocument(html, annotating) }), [html, annotating])

  // A new document means a new page: wait for its annotator to report ready again.
  useEffect(() => { ready.current = false }, [source])
  useEffect(() => {
    if (annotating && ready.current) view.current?.injectJavaScript(setAnnotationsScript(annotations))
  }, [annotating, annotations])

  return (
    <WebView
      ref={view}
      style={styles.reader}
      originWhitelist={["about:*"]}
      source={source}
      javaScriptEnabled={annotating}
      injectedJavaScript={annotating ? ANNOTATOR_SCRIPT : undefined}
      onMessage={event => {
        const message = parseAnnotatorMessage(event.nativeEvent.data)
        if (!message) return
        if (message.type === "ready") {
          ready.current = true
          if (annotations) view.current?.injectJavaScript(setAnnotationsScript(annotations))
        }
        onAnnotatorMessage?.(message)
      }}
      domStorageEnabled={false}
      incognito
      cacheEnabled={false}
      allowFileAccess={false}
      setSupportMultipleWindows={false}
      dataDetectorTypes="none"
      indicatorStyle="white"
      onShouldStartLoadWithRequest={request => shouldLoadInReader(request, url => { Linking.openURL(url).catch(() => undefined) })}
    />
  )
}

const styles = StyleSheet.create({ reader: { flex: 1, backgroundColor: colors.panelSolid } })
