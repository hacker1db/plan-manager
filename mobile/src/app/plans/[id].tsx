import { Redirect, Stack, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { CommentComposer } from "../../components/CommentComposer"
import { Reader } from "../../components/Reader"
import { Button, Eyebrow, Label } from "../../components/ui"
import { buildT3Prompt, t3Links, upsertAnnotation } from "../../lib/annotations"
import type { AnnotatorMessage, BlockTarget } from "../../lib/annotator"
import { errorMessage } from "../../lib/api"
import { useDrafts } from "../../lib/drafts"
import { useSession } from "../../lib/session"
import { PLAN_STATUSES, type PlanRenderResponse, type PlanStatus } from "../../lib/shared"
import { colors, fonts, statusColor } from "../../theme"

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
const NO_COMMENTS: never[] = []

export default function PlanScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { repository, config } = useSession()
  const drafts = useDrafts()
  const insets = useSafeAreaInsets()
  const [document, setDocument] = useState<PlanRenderResponse | null>(null)
  const [composing, setComposing] = useState<BlockTarget | null>(null)
  const [unplaced, setUnplaced] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    if (!repository || !id) return
    setError(null)
    setDocument(null)
    try { setDocument(await repository.document(id)) } catch (cause) { setError(errorMessage(cause)) }
  }, [id, repository])

  useEffect(() => { reload() }, [reload])

  // Signed out (or session replaced) while viewing: drop content and return to the library.
  if (!repository || !id) return <Redirect href="/" />

  const draft = drafts.draft(id)
  const items = draft?.items ?? NO_COMMENTS
  const plan = document?.plan
  const stale = !!(draft && plan && draft.revision !== plan.revision)

  const applyStatus = async (status: PlanStatus) => {
    if (!document) return
    setSaving(true)
    try { await repository.setStatus(document.plan, status); await reload() } catch (cause) { setError(errorMessage(cause)) }
    setSaving(false)
  }

  const chooseStatus = () => {
    if (!document) return
    Alert.alert("Change hosted status", "Update the hosted copy? Your canonical vault is unchanged.", [
      ...PLAN_STATUSES.filter(status => status !== document.plan.status).map(status => ({ text: capitalize(status), onPress: () => { applyStatus(status) } })),
      { text: "Cancel", style: "cancel" as const },
    ], { userInterfaceStyle: "dark" })
  }

  const onAnnotatorMessage = (message: AnnotatorMessage) => {
    if (message.type === "comment") setComposing(message.target)
    else if (message.type === "placement") setUnplaced(message.unplaced.length)
  }

  const saveComment = (note: string) => {
    if (!composing || !plan) return
    // A draft is pinned to the revision whose rendered blocks it was written against.
    drafts.save({ planId: id, revision: draft?.revision ?? plan.revision, items: upsertAnnotation(items, composing, note), openedInT3At: null })
    setComposing(null)
  }

  const openInT3 = async () => {
    if (!plan || !draft) return
    let links
    try { links = t3Links(buildT3Prompt(plan, draft.revision, draft.items), config.t3Repo) } catch (cause) {
      Alert.alert("Too long for T3", cause instanceof Error ? cause.message : "Shorten the comments and try again.", undefined, { userInterfaceStyle: "dark" })
      return
    }
    try { await Linking.openURL(links.app) } catch {
      // T3 Code app not installed or scheme unavailable: the hosted link offers app/desktop/web.
      try { await Linking.openURL(links.web) } catch { setError("Couldn't open T3 Code."); return }
    }
    drafts.save({ ...draft, openedInT3At: Date.now() })
  }

  const confirmClear = () => Alert.alert("Clear comments?", `Remove ${items.length} comment${items.length === 1 ? "" : "s"} on this plan from your phone?`, [
    { text: "Cancel", style: "cancel" },
    { text: "Clear", style: "destructive", onPress: () => drafts.clear(id) },
  ], { userInterfaceStyle: "dark" })

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "" }} />
      {plan ? (
        <View style={styles.head}>
          <Eyebrow>Hosted copy</Eyebrow>
          <Text style={styles.title} accessibilityRole="header">{plan.title}</Text>
          <View style={styles.metadata}>
            <View style={styles.meta}>
              <Label>Status</Label>
              <Text style={[styles.metaValue, { color: statusColor(plan.status) }]}>{capitalize(plan.status)}</Text>
            </View>
            <View style={[styles.meta, styles.metaDivider]}>
              <Label>Updated</Label>
              <Text style={styles.metaMono}>{plan.updated.slice(0, 10)}</Text>
            </View>
            <View style={[styles.meta, styles.metaDivider]}>
              <Label>Revision</Label>
              <Text style={styles.metaMono}>{plan.revision.slice(0, 8)}</Text>
            </View>
          </View>
          {document.statusUnavailableReason ? <Text style={styles.note}>{document.statusUnavailableReason}</Text> : null}
          <View style={styles.actions}>
            {document.statusUnavailableReason ? null : <Button label="Change status" disabled={saving} onPress={chooseStatus} />}
            <Button label="Refresh" disabled={saving} onPress={reload} />
            {saving ? <ActivityIndicator color={colors.accent} /> : null}
          </View>
          {unplaced > 0 ? (
            <Text style={styles.stale}>
              {unplaced} comment{unplaced === 1 ? " no longer matches" : "s no longer match"} the plan text. {unplaced === 1 ? "It's" : "They're"} still included when you open T3.
            </Text>
          ) : null}
          {stale ? (
            <Text style={styles.stale}>
              Plan updated since your comments ({draft!.revision.slice(0, 8)} → {plan.revision.slice(0, 8)}). Review the change, then clear them if they're handled.
            </Text>
          ) : null}
        </View>
      ) : null}
      {!document && !error ? <Text style={styles.loading}>Loading plan…</Text> : null}
      {error ? (
        <View style={styles.warning}>
          <Text style={styles.error}>{error}</Text>
          {!document ? <Button label="Retry" onPress={reload} /> : null}
        </View>
      ) : null}
      {document ? (
        <View style={styles.document}>
          <Reader html={document.html} annotations={items} onAnnotatorMessage={onAnnotatorMessage} />
        </View>
      ) : null}
      {!document ? <View style={styles.fill} /> : null}
      {items.length > 0 ? (
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.barText}>
            <Text style={styles.barCount}>{items.length} comment{items.length === 1 ? "" : "s"}</Text>
            <Text style={styles.barMeta}>
              {draft?.openedInT3At ? `Opened in T3 ${new Date(draft.openedInT3At).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Ready to send to T3"}
            </Text>
          </View>
          <Button label="Clear" variant="danger" onPress={confirmClear} />
          <Button label={draft?.openedInT3At ? "Open again" : "Open in T3"} variant="primary" onPress={openInT3}
            accessibilityHint="Opens T3 Code with a prefilled thread in your vault project. Nothing is sent until you press Send in T3." />
        </View>
      ) : null}
      <CommentComposer
        target={composing}
        existing={composing ? items.find(item => item.key === composing.key)?.note ?? null : null}
        onSave={saveComment}
        onDelete={() => saveComment("")}
        onClose={() => setComposing(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  fill: { flex: 1 },
  head: { paddingHorizontal: 16, paddingTop: 12, gap: 14 },
  title: { fontFamily: fonts.display, fontSize: 32, fontWeight: "700", letterSpacing: -1.2, lineHeight: 33, color: colors.text },
  metadata: { borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panelSolid, flexDirection: "row" },
  meta: { flex: 1, paddingHorizontal: 12, paddingVertical: 11, gap: 6 },
  metaDivider: { borderLeftWidth: 1, borderLeftColor: colors.edge },
  metaValue: { fontFamily: fonts.display, fontSize: 19, fontWeight: "700" },
  metaMono: { fontFamily: fonts.mono, fontSize: 13, color: colors.text, paddingTop: 3 },
  note: { fontFamily: fonts.body, fontSize: 14, lineHeight: 21, color: colors.muted, paddingLeft: 14, borderLeftWidth: 3, borderLeftColor: colors.archived },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  stale: { fontFamily: fonts.body, fontSize: 13.5, lineHeight: 20, color: colors.signal, paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: colors.signal },
  loading: { padding: 16, fontFamily: fonts.mono, fontSize: 12, color: colors.faint },
  warning: { margin: 16, gap: 10, padding: 14, borderWidth: 1, borderColor: colors.danger },
  error: { fontFamily: fonts.mono, fontSize: 12, color: colors.danger },
  document: { flex: 1, backgroundColor: colors.panelSolid },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.accent, backgroundColor: colors.ink },
  barText: { flex: 1, gap: 2 },
  barCount: { fontFamily: fonts.display, fontSize: 17, fontWeight: "700", color: colors.text },
  barMeta: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.faint },
})
