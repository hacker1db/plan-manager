import { Stack } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect, useState } from "react"
import { AppState, StyleSheet, Text, View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { DraftsProvider } from "../lib/drafts"
import { SessionProvider, useSession } from "../lib/session"
import { colors, fonts } from "../theme"

/** Covers plan content whenever the app is not active, so the app switcher never shows it. */
function PrivacyCover() {
  const [active, setActive] = useState(AppState.currentState === "active")
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setActive(state === "active"))
    return () => subscription.remove()
  }, [])
  if (active) return null
  return (
    <View style={[StyleSheet.absoluteFill, styles.cover]} accessibilityElementsHidden>
      <Text style={styles.coverMark}>PL</Text>
      <Text style={styles.coverTitle}>Plan Library</Text>
    </View>
  )
}

/** Comment drafts live only as long as the session: a new generation (sign-in/out) remounts them empty. */
function SessionDrafts({ children }: { children: React.ReactNode }) {
  const { generation } = useSession()
  return <DraftsProvider key={generation}>{children}</DraftsProvider>
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="light" />
        <SessionDrafts>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.ink },
            headerShadowVisible: false,
            headerTintColor: colors.accent,
            headerTitleStyle: { fontFamily: fonts.display, fontWeight: "700", color: colors.text },
            headerBackButtonDisplayMode: "minimal",
            contentStyle: { backgroundColor: colors.paper },
            statusBarStyle: "light",
          }}
        >
          <Stack.Screen name="index" options={{ title: "Plan Library" }} />
          <Stack.Screen name="plans/[id]" options={{ title: "" }} />
        </Stack>
        </SessionDrafts>
        <PrivacyCover />
      </SessionProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  cover: { alignItems: "center", justifyContent: "center", zIndex: 1000, backgroundColor: colors.ink, overflow: "hidden" },
  coverMark: { position: "absolute", right: -12, bottom: -60, fontFamily: fonts.display, fontSize: 260, fontWeight: "900", color: "rgba(233, 242, 247, 0.038)" },
  coverTitle: { fontFamily: fonts.display, fontSize: 30, fontWeight: "700", color: colors.text },
})
