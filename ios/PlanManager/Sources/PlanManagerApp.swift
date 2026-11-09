import SwiftUI

@main struct PlanManagerApp: App {
    private let fixture = ProcessInfo.processInfo.arguments.contains("--fixtures")
    var body: some Scene {
        WindowGroup {
            if fixture { LibraryView(repository: FixtureRepository(), fixture: true, signOut: {}) }
            else { AuthenticatedRoot() }
        }
    }
}
struct AuthenticatedRoot: View {
    @State private var auth = NativeSession()
    @State private var error: String?
    var body: some View {
        Group {
            if !auth.configured {
                ContentUnavailableView("Development configuration required", systemImage: "gear", description: Text("Configure the shared WorkOS environment, approved native redirect and HTTPS Plan Manager service. Use --fixtures for an offline preview."))
            } else if auth.signedIn, let base = auth.serviceURL {
                LibraryView(repository: APIRepository(base: base, token: { try await auth.token() }), fixture: false, signOut: { try auth.signOut() }).id(auth.sessionGeneration)
            } else {
                VStack(spacing: 20) {
                    Text("Plan Manager").font(.largeTitle)
                    Text("Sign in with your existing Plan Manager account.")
                    Button("Sign in") { Task { do { try await auth.signIn() } catch { self.error = "Sign-in could not complete. Please retry." } } }.disabled(auth.signingIn)
                    if auth.signingIn { ProgressView() }
                    if let error { Text(error).foregroundStyle(.red) }
                }.padding()
            }
        }
    }
}
struct LibraryView: View {
    let repository: any PlanRepository
    let fixture: Bool
    let signOut: () async throws -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var plans: [Plan] = []
    @State private var query = ""
    @State private var filter = "all"
    @State private var loading = false
    @State private var error: String?
    @State private var selected: Plan?
    @State private var hidden = false
    private var visible: [Plan] { plans.filter { (filter == "all" || $0.status == filter) && (query.isEmpty || ($0.title + " " + $0.tags.joined(separator: " ")).localizedCaseInsensitiveContains(query)) } }
    var body: some View {
        ZStack {
            NavigationSplitView {
                List(selection: $selected) {
                    if fixture { Text("Offline fixture library").foregroundStyle(.secondary) }
                    Picker("Status", selection: $filter) { ForEach(["all", "active", "completed", "archived"], id: \.self) { Text($0.capitalized).tag($0) } }
                    if loading { ProgressView("Loading plans") }
                    if let error { Text(error).foregroundStyle(.red); Button("Retry") { Task { await reload() } } }
                    if !loading && error == nil && visible.isEmpty { Text("No matching plans") }
                    ForEach(visible) { plan in NavigationLink(value: plan) { VStack(alignment: .leading) { Text(plan.title).font(.headline); Text(plan.status.capitalized).font(.caption).foregroundStyle(.secondary) } } }
                }
                .navigationTitle("Plans")
                .searchable(text: $query)
                .refreshable { await reload() }
                .toolbar { Button("Sign out") { Task { hidden = true; plans = []; selected = nil; do { try await signOut() } catch { self.error = "Sign-out failed. Retry to end the session."; hidden = false } } }.disabled(fixture) }
            } detail: {
                if let selected { DetailView(id: selected.id, repository: repository).id(selected.id) }
                else { ContentUnavailableView("Choose a plan", systemImage: "doc.text") }
            }.task { await reload() }
            if hidden || scenePhase != .active { Color(.systemBackground).ignoresSafeArea().overlay { Text("Plan Manager").font(.title) } }
        }
    }
    private func reload() async {
        loading = true; error = nil
        do { plans = try await repository.library() } catch { plans = []; selected = nil; self.error = error.localizedDescription }
        loading = false
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
        VStack(alignment: .leading) {
            if let document {
                Text(document.plan.title).font(.title).padding(.horizontal)
                Text("Hosted copy • \(document.plan.status) • \(document.plan.revision.prefix(8))").font(.caption).padding(.horizontal)
                if let reason = document.statusUnavailableReason { Text(reason).font(.caption).padding(.horizontal) }
                else { Menu("Change hosted status") { ForEach(["active", "completed", "archived"], id: \.self) { status in Button(status.capitalized) { pendingStatus = status } } }.disabled(saving).padding(.horizontal) }
                Reader(html: document.html)
            } else if error == nil { ProgressView("Loading plan") }
            if let error { Text(error).foregroundStyle(.red).padding() }
            Button("Refresh") { Task { await reload() } }.padding().disabled(saving)
        }
        .task { await reload() }
        .confirmationDialog("Update the hosted copy? Your canonical vault is unchanged.", isPresented: Binding(get: { pendingStatus != nil }, set: { if !$0 { pendingStatus = nil } })) {
            Button("Update hosted status") { let status = pendingStatus; pendingStatus = nil; Task { if let status, let document { saving = true; do { _ = try await repository.status(document.plan, to: status); await reload() } catch { self.error = error.localizedDescription }; saving = false } } }
        }
    }
    private func reload() async { error = nil; document = nil; do { document = try await repository.document(id) } catch { self.error = error.localizedDescription } }
}
