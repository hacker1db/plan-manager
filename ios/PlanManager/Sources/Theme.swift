import SwiftUI

// Native mirror of the :root tokens in src/dashboard/style.css (the web source of truth).
// The reader WebView loads that stylesheet itself; only native chrome uses these values.
enum Theme {
    static let ink = Color(hex: 0x0D1116)
    static let paper = Color(hex: 0x11171E)
    static let paperDeep = Color(hex: 0x05080B)
    static let panel = Color.white.opacity(0.032)
    static let panelRaised = Color.white.opacity(0.055)
    static let edge = Color(hex: 0x2B3846)
    static let rule = Color(hex: 0x1E2833)
    static let text = Color(hex: 0xE9F2F7)
    static let muted = Color(hex: 0x8FA1B2)
    static let faint = Color(hex: 0x7D8D9D)
    static let accent = Color(hex: 0x04D1F9)
    static let accentDark = Color(hex: 0x0AA8C9)
    static let signal = Color(hex: 0x9AD900)
    static let blue = Color(hex: 0x987AFB)
    static let purple = Color(hex: 0xFCA6FF)
    static let active = Color(hex: 0x37F499)
    static let completed = blue
    static let archived = Color(hex: 0xE58F2A)
    static let danger = Color(hex: 0xF16C75)
    static let tag = purple

    static func status(_ status: String) -> Color {
        switch status { case "active": active; case "completed": completed; case "archived": archived; default: edge }
    }

    // --display / --body / --mono; sizes are the web rem values × 16, scaled with Dynamic Type.
    static func display(_ size: CGFloat, _ style: Font.TextStyle = .title) -> Font { .custom("Iowan Old Style", size: size, relativeTo: style) }
    static func body(_ size: CGFloat, _ style: Font.TextStyle = .body) -> Font { .custom("Avenir Next", size: size, relativeTo: style) }
    static func mono(_ size: CGFloat, _ style: Font.TextStyle = .caption) -> Font { .custom("Menlo", size: size, relativeTo: style) }

    static func date(_ value: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = iso.date(from: value) ?? { iso.formatOptions = [.withInternetDateTime]; return iso.date(from: value) }() ?? { iso.formatOptions = [.withFullDate]; return iso.date(from: value) }()
        return parsed?.formatted(date: .numeric, time: .standard) ?? value
    }
}

extension Color {
    init(hex: UInt32) { self.init(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255) }
}

/// body background: 28px grid over --paper with the two radial glows.
struct PaperBackground: View {
    var body: some View {
        Canvas { context, size in
            let grid = Path { path in
                stride(from: 0, through: size.width, by: 28).forEach { path.addRect(CGRect(x: $0, y: 0, width: 1, height: size.height)) }
                stride(from: 0, through: size.height, by: 28).forEach { path.addRect(CGRect(x: 0, y: $0, width: size.width, height: 1)) }
            }
            context.fill(grid, with: .color(.white.opacity(0.028)))
        }
        .background {
            ZStack {
                Theme.paper
                RadialGradient(colors: [Theme.accent.opacity(0.10), .clear], center: UnitPoint(x: 0.88, y: 0.03), startRadius: 0, endRadius: 384)
                RadialGradient(colors: [Theme.blue.opacity(0.09), .clear], center: UnitPoint(x: 0.04, y: 0.92), startRadius: 0, endRadius: 416)
            }
        }
        .ignoresSafeArea()
    }
}

/// .topline: 8px tri-colour rule.
struct Topline: View {
    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 0) {
                Theme.accent.frame(width: proxy.size.width * 0.52)
                Theme.signal.frame(width: proxy.size.width * 0.16)
                Theme.blue
            }
        }
        .frame(height: 8)
    }
}

/// .eyebrow: mono caps label with a 32×2 signal bar.
struct Eyebrow: View {
    let text: String
    var body: some View {
        HStack(spacing: 12) {
            Theme.signal.frame(width: 32, height: 2)
            Text(text.uppercased()).font(Theme.mono(11.2)).tracking(1.8).foregroundStyle(Theme.signal)
        }
        .accessibilityElement(children: .combine)
    }
}

/// .status-badge
struct StatusBadge: View {
    let status: String
    var body: some View {
        Text(status.uppercased())
            .font(Theme.mono(9.9).weight(.bold)).tracking(1.2)
            .padding(.vertical, 3).padding(.horizontal, 9)
            .overlay(Rectangle().stroke(Theme.status(status), lineWidth: 1))
            .foregroundStyle(Theme.status(status))
    }
}

/// .plan-tag
struct TagChip: View {
    let tag: String
    var body: some View {
        Text(tag).font(Theme.mono(10.4)).foregroundStyle(Theme.tag)
            .padding(.vertical, 2).padding(.horizontal, 8)
            .overlay(Rectangle().stroke(Theme.rule, lineWidth: 1))
    }
}

/// .btn (and .btn.primary / .btn.danger)
struct WebButtonStyle: ButtonStyle {
    enum Kind { case plain, primary, danger }
    var kind: Kind = .plain
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        let tint: Color = kind == .danger ? Theme.danger : Theme.accent
        let filled = kind == .primary || pressed
        configuration.label
            .font(Theme.mono(11.2)).tracking(0.45).lineLimit(1)
            .padding(.vertical, 7).padding(.horizontal, 11)
            .frame(minHeight: 44)
            .foregroundStyle(filled ? Theme.ink : kind == .plain ? Theme.muted : tint)
            .background(filled ? tint : .clear)
            .overlay(Rectangle().stroke(kind == .plain && !pressed ? Theme.edge : tint, lineWidth: 1))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
    }
}

/// Bordered panel with the 7px hard offset shadow (.card / .document).
struct PanelModifier: ViewModifier {
    var offset: CGFloat = 7
    var fill: Color = Theme.panel
    func body(content: Content) -> some View {
        content
            .background(fill)
            .background(Theme.paper) // CSS box-shadow never shows through the box itself
            .overlay(Rectangle().stroke(Theme.edge, lineWidth: 1))
            .background(Theme.paperDeep.offset(x: offset, y: offset))
    }
}

extension View {
    func webPanel(offset: CGFloat = 7, fill: Color = Theme.panel) -> some View { modifier(PanelModifier(offset: offset, fill: fill)) }
}

/// .shell footer
struct ShellFooter: View {
    var trailing = "Private · Owner access"
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Theme.edge.frame(height: 2)
            Text("PLAN MANAGER")
            Text(trailing.uppercased())
        }
        .font(Theme.mono(10.4)).tracking(0.8).foregroundStyle(Theme.faint)
        .padding(.top, 48)
    }
}
