import SwiftUI

@main struct PlanManagerApp: App {
    private let fixture = ProcessInfo.processInfo.arguments.contains("--fixtures")
    var body: some Scene {
        WindowGroup {
            Group {
                if fixture { LibraryView(repository: FixtureRepository(), fixture: true, signOut: {}) }
                else { AuthenticatedRoot() }
            }
            .preferredColorScheme(.dark) // the web dashboard is dark-only (color-scheme: dark)
        }
    }
}
struct AuthenticatedRoot: View {
    @State private var auth = NativeSession()
    @State private var error: String?
    var body: some View {
        Group {
            if !auth.configured {
                Landing(eyebrow: "Setup required", title: "Development", emphasis: "configuration", summary: "Configure the shared WorkOS environment, approved native redirect and HTTPS Plan Manager service. Use --fixtures for an offline preview.")
            } else if auth.signedIn, let base = auth.serviceURL {
                LibraryView(repository: APIRepository(base: base, token: { try await auth.token() }), fixture: false, signOut: { try auth.signOut() }).id(auth.sessionGeneration)
            } else {
                Landing(eyebrow: "Private library", title: "Plan", emphasis: "Library", summary: "Sign in with your existing Plan Manager account.") {
                    Button("Sign in") { Task { do { try await auth.signIn() } catch { self.error = "Sign-in could not complete. Please retry." } } }
                        .buttonStyle(WebButtonStyle(kind: .primary)).disabled(auth.signingIn)
                    if auth.signingIn { ProgressView().tint(Theme.accent) }
                    if let error { WarningText(error) }
                }
            }
        }
    }
}

/// Hero-only screen used before the library is available.
struct Landing<Actions: View>: View {
    let eyebrow: String, title: String, emphasis: String, summary: String
    @ViewBuilder var actions: Actions
    init(eyebrow: String, title: String, emphasis: String, summary: String, @ViewBuilder actions: () -> Actions) {
        self.eyebrow = eyebrow; self.title = title; self.emphasis = emphasis; self.summary = summary; self.actions = actions()
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Hero(eyebrow: eyebrow, title: title, emphasis: emphasis, summary: summary)
                actions
                ShellFooter()
            }.padding(.horizontal, 12).padding(.top, 24)
        }
        .safeAreaInset(edge: .top, spacing: 0) { Topline() }
        .background(PaperBackground())
    }
}

extension Landing where Actions == EmptyView {
    init(eyebrow: String, title: String, emphasis: String, summary: String) { self.init(eyebrow: eyebrow, title: title, emphasis: emphasis, summary: summary) { EmptyView() } }
}

/// .hero: ink panel, eyebrow, display h1 with italic accent <em>, signal-ruled summary, "PL" watermark.
struct Hero: View {
    let eyebrow: String, title: String, emphasis: String, summary: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(text: eyebrow).padding(.bottom, 38)
            (Text(title + " ") + Text(emphasis).italic().fontWeight(.regular).foregroundColor(Theme.accent))
                .font(Theme.display(44.8, .largeTitle).weight(.bold)).tracking(-2.4)
                .foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !summary.isEmpty {
                HStack(spacing: 0) {
                    Theme.signal.frame(width: 3)
                    Text(summary).font(Theme.body(15.2)).foregroundStyle(Theme.muted).padding(.leading, 24)
                }.fixedSize(horizontal: false, vertical: true).padding(.top, 40)
            }
        }
        .padding(30)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .bottomTrailing) {
            Text("PL").font(.custom("Iowan Old Style", size: 256).weight(.black)).foregroundStyle(Theme.text.opacity(0.038))
                .offset(x: 10, y: 70).accessibilityHidden(true)
        }
        .background(Theme.ink).clipped()
        .overlay(Rectangle().stroke(Theme.edge, lineWidth: 1))
        .shadow(color: .black.opacity(0.55), radius: 30, y: 22)
    }
}

struct WarningText: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        HStack(spacing: 0) {
            Theme.archived.frame(width: 3)
            Text(text).font(Theme.mono(11.5)).foregroundStyle(Theme.archived).padding(.vertical, 12).padding(.horizontal, 15)
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.archived.opacity(0.09))
        .overlay(Rectangle().stroke(Theme.archived, lineWidth: 1))
    }
}

struct LibraryView: View {
    let repository: any PlanRepository
    let fixture: Bool
    let signOut: () async throws -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var plans: [Plan] = []
    @State private var query = ""
    @State private var filter = "all"
    @State private var tag: String?
    @State private var loading = false
    @State private var error: String?
    @State private var path: [Plan] = []
    @State private var hidden = false
    private let statuses = ["all", "active", "completed", "archived"]
    private var visible: [Plan] { plans.filter { (filter == "all" || $0.status == filter) && (tag == nil || $0.tags.contains(tag!)) && (query.isEmpty || ($0.title + " " + $0.tags.joined(separator: " ")).localizedCaseInsensitiveContains(query)) } }
    private var tags: [String] { Array(Set(plans.flatMap(\.tags))).sorted() }
    private func count(_ status: String) -> Int { status == "all" ? plans.count : plans.filter { $0.status == status }.count }
    var body: some View {
        ZStack {
            NavigationStack(path: $path) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        rail
                        Hero(eyebrow: "Markdown plan library", title: "Every plan,", emphasis: "one shelf", summary: summary).padding(.top, 24)
                        metadata
                        if fixture { WarningText("Offline fixture library. No hosted service is connected.").padding(.top, 22) }
                        if let error {
                            WarningText(error).padding(.top, 22)
                            Button("Retry") { Task { await reload() } }.buttonStyle(WebButtonStyle()).padding(.top, 8)
                        }
                        SectionHead(number: "01", title: "Plans")
                        cards
                        ShellFooter(trailing: fixture ? "Fixture data · Offline" : "Private · Owner access")
                    }
                    .padding(.horizontal, 12).padding(.top, 24).padding(.bottom, 32)
                    .frame(maxWidth: 1480)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await reload() }
                .scrollDismissesKeyboard(.interactively)
                .safeAreaInset(edge: .top, spacing: 0) { Topline() }
                .background(PaperBackground())
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Plan.self) { DetailView(id: $0.id, repository: repository).id($0.id) }
            }
            .tint(Theme.accent)
            .task { await reload() }
            if hidden || scenePhase != .active { Theme.ink.ignoresSafeArea().overlay { Text("Plan Library").font(Theme.display(28).weight(.bold)).foregroundStyle(Theme.text) } }
        }
    }
    private var summary: String {
        if loading && plans.isEmpty { return "" }
        let noun = visible.count == 1 ? "plan" : "plans"
        return "Showing \(visible.count) of \(plans.count) \(noun)."
    }
    /// .rail collapsed to the top of the page, as the web does below 900px.
    private var rail: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(fixture ? "FIXTURE LIBRARY" : "PRIVATE LIBRARY").font(Theme.mono(11.5)).tracking(1.8).foregroundStyle(Theme.muted)
                    Text("Plan Library").font(Theme.display(21.6, .title2).weight(.bold)).foregroundStyle(Theme.text)
                }
                Spacer()
                Button("Sign out") { Task { hidden = true; plans = []; path = []; do { try await signOut() } catch { self.error = "Sign-out failed. Retry to end the session."; hidden = false } } }
                    .buttonStyle(WebButtonStyle()).disabled(fixture)
            }
            TextField("", text: $query, prompt: Text("Search plans").foregroundColor(Theme.faint))
                .font(Theme.mono(12.5)).foregroundStyle(Theme.text).tint(Theme.accent)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                .padding(.vertical, 9).padding(.horizontal, 11).frame(minHeight: 44)
                .background(Theme.panel).overlay(Rectangle().stroke(Theme.edge, lineWidth: 1))
                .accessibilityLabel("Search plans")
            VStack(alignment: .leading, spacing: 12) {
                RailLabel("Status")
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], spacing: 0) {
                    ForEach(statuses, id: \.self) { status in
                        Button { filter = status } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(status.capitalized).font(Theme.body(13.8)).foregroundStyle(filter == status ? Theme.text : Theme.muted)
                                Spacer()
                                Text("\(count(status))").font(Theme.mono(10.7)).foregroundStyle(Theme.accent)
                            }
                            .padding(.vertical, 8).frame(minHeight: 44)
                            .overlay(alignment: .bottom) { (filter == status ? Theme.accent : .clear).frame(height: 1) }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(filter == status ? .isSelected : [])
                    }
                }
            }
            if !tags.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    RailLabel("Tags")
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(tags, id: \.self) { value in
                                let on = tag == value
                                Button { tag = on ? nil : value } label: {
                                    Text(value).font(Theme.mono(10.9)).padding(.vertical, 4).padding(.horizontal, 9).frame(minHeight: 32)
                                        .foregroundStyle(on ? Theme.ink : Theme.muted).background(on ? Theme.tag : .clear)
                                        .overlay(Rectangle().stroke(on ? Theme.tag : Theme.rule, lineWidth: 1))
                                }
                                .buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
                            }
                        }
                    }
                }
            }
        }
        .padding(.bottom, 20)
        .overlay(alignment: .bottom) { Theme.edge.frame(height: 2) }
    }
    /// .metadata strip: 1 column on phones (web ≤480px), 4 on regular width.
    private var metadata: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: sizeClass == .regular ? 4 : 1)
        return LazyVGrid(columns: columns, spacing: 0) {
            ForEach(statuses, id: \.self) { status in
                VStack(alignment: .leading, spacing: 8) {
                    Text(status == "all" ? "TOTAL" : status.uppercased()).font(Theme.mono(9.8)).tracking(1.4).foregroundStyle(Theme.faint)
                    Text("\(count(status))").font(Theme.display(24).weight(.bold)).foregroundStyle(status == "all" ? Theme.text : Theme.status(status))
                }
                .frame(maxWidth: .infinity, minHeight: sizeClass == .regular ? 54 : 0, alignment: .topLeading)
                .padding(.vertical, 17).padding(.horizontal, 19)
                .overlay(Rectangle().stroke(Theme.edge, lineWidth: 0.5))
                .accessibilityElement(children: .combine)
            }
        }
        .background(Theme.panel)
        .overlay(Rectangle().stroke(Theme.edge, lineWidth: 1))
        .padding(.top, 2)
    }
    @ViewBuilder private var cards: some View {
        if loading && plans.isEmpty {
            Text("LOADING PLANS…").font(Theme.mono(12)).tracking(1.2).foregroundStyle(Theme.faint).frame(maxWidth: .infinity).padding(.vertical, 48)
        } else if visible.isEmpty && error == nil {
            VStack(spacing: 8) {
                Text("No matching plans").font(Theme.display(25.6).weight(.bold)).foregroundStyle(Theme.text)
                Text("Adjust the search or filters.").font(Theme.body(15)).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 64).padding(.horizontal, 24)
            .overlay(Rectangle().stroke(Theme.edge, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        } else {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: sizeClass == .regular ? 2 : 1), spacing: 16) {
                ForEach(Array(visible.enumerated()), id: \.element.id) { index, plan in
                    NavigationLink(value: plan) { PlanCard(plan: plan, index: index, compact: sizeClass != .regular) }.buttonStyle(.plain)
                }
            }
        }
    }
    private func reload() async {
        loading = true; error = nil
        do { plans = try await repository.library() } catch { plans = []; path = []; self.error = error.localizedDescription }
        loading = false
    }
}

struct RailLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text.uppercased()).font(Theme.mono(10.1)).tracking(1.4).foregroundStyle(Theme.faint).accessibilityAddTraits(.isHeader) }
}

/// .section-head: 2px edge rule, mono number, display h2.
struct SectionHead: View {
    let number: String, title: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(number) —").font(Theme.mono(11.5)).tracking(1.1).foregroundStyle(Theme.accent)
            Text(title).font(Theme.display(30.4, .title).weight(.bold)).tracking(-1.2).foregroundStyle(Theme.text).accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 18)
        .overlay(alignment: .top) { Theme.edge.frame(height: 2) }
        .padding(.top, 56).padding(.bottom, 30)
    }
}

/// .card: status edge, index marker, display title, meta row, hard offset shadow (4px on phones).
struct PlanCard: View {
    let plan: Plan, index: Int, compact: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(plan.title).font(Theme.display(24.8, .title2).weight(.bold)).tracking(-0.37).foregroundStyle(Theme.text)
                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true).padding(.trailing, 24)
            FlowRow {
                StatusBadge(status: plan.status)
                Text(Theme.date(plan.updated)).font(Theme.mono(10.9)).foregroundStyle(Theme.faint)
                ForEach(plan.tags, id: \.self) { TagChip(tag: $0) }
            }
        }
        .padding(compact ? 20 : 26)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .topTrailing) { Text(String(format: "%02d", index + 1)).font(Theme.mono(9.9)).foregroundStyle(Theme.faint).padding(.top, 14).padding(.trailing, 17) }
        .overlay(alignment: .leading) { Theme.status(plan.status).frame(width: 3) }
        .webPanel(offset: compact ? 4 : 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the plan")
    }
}

/// flex-wrap row for badges, dates and tags.
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { arrange(proposal.width ?? .infinity, subviews).size }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, point) in zip(subviews, arrange(bounds.width, subviews).points) { subview.place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified) }
    }
    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        var points: [CGPoint] = [], x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            points.append(CGPoint(x: x, y: y)); x += size.width + spacing; row = max(row, size.height); widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + row), points)
    }
}

struct DetailView: View {
    let id: String
    let repository: any PlanRepository
    @State private var document: Document?
    @State private var error: String?
    @State private var saving = false
    @State private var pendingStatus: String?
    var body: some View {
        VStack(spacing: 0) {
            if let document {
                if let reason = document.statusUnavailableReason { WarningText(reason).padding(.horizontal, 12).padding(.top, 8) }
                Reader(html: Reader.page(document))
            } else if error == nil {
                Text("LOADING PLAN…").font(Theme.mono(12)).tracking(1.2).foregroundStyle(Theme.faint).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let error { WarningText(error).padding(12) }
        }
        .safeAreaInset(edge: .top, spacing: 0) { Topline() }
        .background(PaperBackground())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.ink, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) { Text("Plan Library").font(Theme.display(17, .headline).weight(.bold)).foregroundStyle(Theme.text) }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let document, document.statusUnavailableReason == nil {
                    Menu {
                        ForEach(["active", "completed", "archived"], id: \.self) { status in
                            Button { pendingStatus = status } label: { if status == document.plan.status { Label(status, systemImage: "checkmark") } else { Text(status) } }
                        }
                    } label: {
                        Text(document.plan.status).font(Theme.mono(11.2)).foregroundStyle(Theme.text)
                            .padding(.vertical, 6).padding(.horizontal, 9).background(Theme.ink).overlay(Rectangle().stroke(Theme.edge, lineWidth: 1))
                    }
                    .disabled(saving).accessibilityLabel("Plan status, \(document.plan.status)")
                }
                Button { Task { await reload() } } label: { Image(systemName: "arrow.clockwise") }.disabled(saving).accessibilityLabel("Refresh")
            }
        }
        .task { await reload() }
        .confirmationDialog("Update the hosted copy? Your canonical vault is unchanged.", isPresented: Binding(get: { pendingStatus != nil }, set: { if !$0 { pendingStatus = nil } }), titleVisibility: .visible) {
            Button("Update hosted status") { let status = pendingStatus; pendingStatus = nil; Task { if let status, let document { saving = true; do { _ = try await repository.status(document.plan, to: status); await reload() } catch { self.error = error.localizedDescription }; saving = false } } }
        }
    }
    private func reload() async { error = nil; document = nil; do { document = try await repository.document(id) } catch { self.error = error.localizedDescription } }
}
