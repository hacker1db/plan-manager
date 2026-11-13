import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native"
import { colors, fonts, OFFSET, statusColor } from "../theme"

/** `.eyebrow`: mono, uppercase, signal yellow, with a leading rule. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <View style={styles.eyebrow}>
      <View style={styles.eyebrowRule} />
      <Text style={styles.eyebrowText}>{children}</Text>
    </View>
  )
}

/** `.rail-label` / `.meta-label`: small mono uppercase label in the faint tone. */
export function Label({ children, color = colors.faint }: { children: ReactNode; color?: string }) {
  return <Text style={[styles.label, { color }]}>{children}</Text>
}

/** `.status-badge`: bordered uppercase mono badge in the status colour. */
export function StatusBadge({ status }: { status: string }) {
  const color = statusColor(status)
  return <Text style={[styles.badge, { color, borderColor: color }]}>{status.toUpperCase()}</Text>
}

/** `.plan-tag` */
export function Tag({ children }: { children: ReactNode }) {
  return <Text style={styles.tag}>{children}</Text>
}

/** `.btn`, `.btn.primary`, `.btn.danger` */
export function Button({ label, onPress, variant = "default", disabled, accessibilityHint }: {
  label: string
  onPress: () => void
  variant?: "default" | "primary" | "danger"
  disabled?: boolean
  accessibilityHint?: string
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && { backgroundColor: pressed ? colors.highlight : colors.accent, borderColor: pressed ? colors.highlight : colors.accent },
        variant === "danger" && { borderColor: colors.danger },
        variant === "default" && pressed && { borderColor: colors.accent, backgroundColor: colors.panelRaised },
        disabled && { opacity: 0.45 },
      ]}
    >
      {({ pressed }) => (
        <Text style={[styles.buttonLabel, { color: variant === "primary" ? colors.ink : variant === "danger" ? colors.danger : pressed ? colors.accent : colors.muted }]}>
          {label}
        </Text>
      )}
    </Pressable>
  )
}

/**
 * `.card`: panel surface, edge border, hard offset shadow and a 3px status stripe. The shadow is
 * a real offset block (not a blurred iOS shadow) so it renders identically on Android.
 */
export function Card({ children, stripe, pressed, style }: { children: ReactNode; stripe?: string; pressed?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.cardWrap, style]}>
      <View style={[styles.cardShadow, { backgroundColor: pressed ? colors.accentDark : colors.paperDeep }]} />
      <View style={[styles.card, { borderColor: pressed ? colors.accent : colors.edge, transform: pressed ? [{ translateX: -2 }, { translateY: -2 }] : [] }]}>
        <View style={[styles.stripe, { backgroundColor: stripe ?? colors.edge }]} />
        {children}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  eyebrow: { flexDirection: "row", alignItems: "center", gap: 12 },
  eyebrowRule: { width: 32, height: 2, backgroundColor: colors.signal },
  eyebrowText: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.8, color: colors.signal, textTransform: "uppercase" },
  label: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase" },
  badge: { alignSelf: "flex-start", paddingHorizontal: 9, paddingVertical: 3, borderWidth: 1, fontFamily: fonts.mono, fontSize: 10, fontWeight: "700", letterSpacing: 1.2 },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: colors.rule, fontFamily: fonts.mono, fontSize: 10.5, color: colors.tag },
  button: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", paddingHorizontal: 13, paddingVertical: 9, borderWidth: 1, borderColor: colors.edge },
  buttonLabel: { fontFamily: fonts.mono, fontSize: 12, letterSpacing: 0.5 },
  // Padding (not margin) reserves the shadow's room, so callers' margins are never overridden.
  cardWrap: { paddingRight: OFFSET, paddingBottom: OFFSET },
  cardShadow: { position: "absolute", top: OFFSET, left: OFFSET, right: 0, bottom: 0 },
  card: { padding: 20, paddingLeft: 23, gap: 12, borderWidth: 1, backgroundColor: colors.panelSolid, overflow: "hidden" },
  stripe: { position: "absolute", top: 0, bottom: 0, left: 0, width: 3 },
})
