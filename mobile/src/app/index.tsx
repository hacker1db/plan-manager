import { Link, Stack } from "expo-router"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native"
import { Button, Card, Eyebrow, Label, StatusBadge, Tag } from "../components/ui"
import { errorMessage, type PlanRepository } from "../lib/api"
import { visiblePlans, type StatusFilter } from "../lib/filter"
import { useSession } from "../lib/session"
import { PLAN_STATUSES, type Plan } from "../lib/shared"
import { colors, fonts, statusColor } from "../theme"

const FILTERS: StatusFilter[] = ["all", ...PLAN_STATUSES]
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

export default function Home() {
  const session = useSession()
  if (!session.config.fixtures && !session.configured) {
    return (
      <Hero eyebrow="Configuration required" title="Connect a" emphasis="library">
        <Text style={styles.summary}>
          Set PLAN_MANAGER_WORKOS_CLIENT_ID, PLAN_MANAGER_WORKOS_REDIRECT_URI and an HTTPS PLAN_MANAGER_SERVICE_URL in mobile/.env.local, or PLAN_MANAGER_FIXTURES=1 for an offline preview.
        </Text>
      </Hero>
    )
  }
  if (session.phase === "loading") return <View style={styles.centered}><ActivityIndicator color={colors.accent} /></View>
  if (session.repository) return <Library key={session.generation} repository={session.repository} fixture={session.config.fixtures} />
  return <SignIn />
}

/** The web `.hero`: ink panel, yellow eyebrow, serif headline with an italic aqua accent, and the PL watermark. */
function Hero({ eyebrow, title, emphasis, children }: { eyebrow: string; title: string; emphasis: string; children?: ReactNode }) {
  return (
    <View style={styles.screen}>
      <View style={styles.hero}>
        <Text style={styles.heroMark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">PL</Text>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Text style={styles.heroTitle} accessibilityRole="header">
          {title} <Text style={styles.heroEmphasis}>{emphasis}</Text>
        </Text>
        {children}
      </View>
    </View>
  )
}

function SignIn() {
  const { signIn, signingIn } = useSession()
  const [error, setError] = useState<string | null>(null)
  return (
    <Hero eyebrow="Markdown plan library" title="Every plan," emphasis="one shelf">
      <Text style={styles.summary}>Sign in with your existing Plan Manager account.</Text>
      <View style={styles.row}>
        <Button
          label={signingIn ? "Signing in…" : "Sign in"}
          variant="primary"
          disabled={signingIn}
          onPress={() => { setError(null); signIn().catch(() => setError("Sign-in could not complete. Please retry.")) }}
        />
        {signingIn ? <ActivityIndicator color={colors.accent} /> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Hero>
  )
}

function Library({ repository, fixture }: { repository: PlanRepository; fixture: boolean }) {
  const { signOut } = useSession()
  const [plans, setPlans] = useState<Plan[]>([])
  const [filter, setFilter] = useState<StatusFilter>("all")
  const [query, setQuery] = useState("")
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setPlans(await repository.library()) } catch (cause) { setPlans([]); setError(errorMessage(cause)) }
    setLoading(false)
  }, [repository])

  useEffect(() => { reload() }, [reload])

  const visible = visiblePlans(plans, filter, query)
  const count = (option: StatusFilter) => (option === "all" ? plans.length : plans.filter(plan => plan.status === option).length)

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: fixture ? undefined : () => (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => { setPlans([]); signOut().catch(() => setError("Sign-out failed. Retry to end the session.")) }}>
              <Text style={styles.headerAction}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={visible}
        keyExtractor={plan => plan.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl tintColor={colors.accent} refreshing={loading && plans.length > 0} onRefresh={reload} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.mark}>
              <Label color={colors.muted}>{fixture ? "Offline fixture library" : "Hosted library"}</Label>
              <Text style={styles.markTitle}>Plan Library</Text>
            </View>
            <TextInput
              value={query}
              onChangeText={setQuery}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Search plans"
              placeholderTextColor={colors.faint}
              selectionColor={colors.accent}
              keyboardAppearance="dark"
              autoCorrect={false}
              autoCapitalize="none"
              clearButtonMode="while-editing"
              accessibilityLabel="Search plans"
              style={[styles.search, focused && { borderColor: colors.accent, backgroundColor: colors.panelRaisedSolid }]}
            />
            <View>
              <Label>Status</Label>
              <View style={styles.filters} accessibilityRole="tablist">
                {FILTERS.map(option => {
                  const selected = filter === option
                  return (
                    <Pressable
                      key={option}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      onPress={() => setFilter(option)}
                      style={[styles.filter, { borderBottomColor: selected ? colors.accent : "transparent" }]}
                    >
                      <Text style={[styles.filterLabel, { color: selected ? colors.text : colors.muted }]}>{capitalize(option)}</Text>
                      <Text style={styles.filterCount}>{count(option)}</Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionNo}>01 —</Text>
              <Text style={styles.sectionTitle} accessibilityRole="header">Plans</Text>
            </View>
            {loading && plans.length === 0 ? <Text style={styles.loading}>Loading plans…</Text> : null}
            {error ? (
              <View style={styles.warning}>
                <Text style={styles.error}>{error}</Text>
                <Button label="Retry" onPress={reload} />
              </View>
            ) : null}
            {!loading && !error && visible.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No matching plans</Text>
                <Text style={styles.summary}>Try another search or status.</Text>
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <Link href={{ pathname: "/plans/[id]", params: { id: item.id } }} asChild>
            <Pressable accessibilityRole="link" accessibilityLabel={`${item.title}, ${item.status}`}>
              {({ pressed }) => (
                <Card stripe={statusColor(item.status)} pressed={pressed} style={styles.card}>
                  <Text style={styles.cardIndex}>{String(index + 1).padStart(2, "0")}</Text>
                  <Text style={[styles.planTitle, pressed && { color: colors.accent }]}>{item.title}</Text>
                  <View style={styles.meta}>
                    <StatusBadge status={item.status} />
                    <Text style={styles.date}>{item.updated.slice(0, 10)}</Text>
                    {item.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}
                  </View>
                </Card>
              )}
            </Pressable>
          </Link>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper },
  hero: { margin: 16, marginTop: 24, padding: 28, gap: 22, backgroundColor: colors.ink, borderWidth: 1, borderColor: colors.edge, overflow: "hidden" },
  heroMark: { position: "absolute", right: -10, bottom: -70, fontFamily: fonts.display, fontSize: 230, fontWeight: "900", color: "rgba(233, 242, 247, 0.038)" },
  heroTitle: { fontFamily: fonts.display, fontSize: 46, fontWeight: "700", letterSpacing: -2.2, lineHeight: 44, color: colors.text },
  heroEmphasis: { fontStyle: "italic", fontWeight: "400", color: colors.accent },
  summary: { fontFamily: fonts.body, fontSize: 15, lineHeight: 24, color: colors.muted, paddingLeft: 16, borderLeftWidth: 3, borderLeftColor: colors.signal },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  error: { fontFamily: fonts.mono, fontSize: 12, color: colors.danger, flexShrink: 1 },
  headerAction: { fontFamily: fonts.mono, fontSize: 13, color: colors.accent },
  list: { paddingBottom: 40 },
  header: { padding: 16, gap: 18 },
  mark: { gap: 8 },
  markTitle: { fontFamily: fonts.display, fontSize: 22, fontWeight: "700", color: colors.text },
  search: { paddingHorizontal: 11, paddingVertical: 10, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panelSolid, color: colors.text, fontFamily: fonts.mono, fontSize: 14 },
  filters: { marginTop: 10 },
  filter: { flexDirection: "row", alignItems: "baseline", gap: 10, paddingVertical: 8, borderBottomWidth: 1 },
  filterLabel: { fontFamily: fonts.body, fontSize: 15 },
  filterCount: { marginLeft: "auto", fontFamily: fonts.mono, fontSize: 11, color: colors.accent },
  sectionHead: { flexDirection: "row", alignItems: "flex-start", gap: 14, marginTop: 14, paddingTop: 16, borderTopWidth: 2, borderTopColor: colors.edge },
  sectionNo: { fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.1, color: colors.accent, paddingTop: 8 },
  sectionTitle: { fontFamily: fonts.display, fontSize: 32, fontWeight: "700", letterSpacing: -1.3, color: colors.text },
  loading: { fontFamily: fonts.mono, fontSize: 12, color: colors.faint },
  warning: { gap: 10, padding: 14, borderWidth: 1, borderColor: colors.danger },
  empty: { gap: 10, padding: 20, borderWidth: 1, borderStyle: "dashed", borderColor: colors.edge },
  emptyTitle: { fontFamily: fonts.display, fontSize: 20, fontWeight: "700", color: colors.text },
  card: { marginHorizontal: 16, marginBottom: 16 },
  cardIndex: { position: "absolute", top: 12, right: 14, fontFamily: fonts.mono, fontSize: 10, color: colors.faint },
  planTitle: { fontFamily: fonts.display, fontSize: 23, fontWeight: "700", lineHeight: 25, letterSpacing: -0.3, color: colors.text, paddingRight: 24 },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  date: { fontFamily: fonts.mono, fontSize: 11, color: colors.faint },
})
