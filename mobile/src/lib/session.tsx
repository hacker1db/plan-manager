import Constants from "expo-constants"
import * as Crypto from "expo-crypto"
import * as SecureStore from "expo-secure-store"
import * as WebBrowser from "expo-web-browser"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ApiError, createApiRepository, type PlanRepository } from "./api"
import { accessTokenExpiry, authorizationCode, authorizationUrl, createPkce, exchangeCode, refreshTokens, type CryptoProvider, type Tokens } from "./auth"
import { isConfigured, readConfig, type AppConfig } from "./config"
import { createFixtureRepository } from "./fixtures"

WebBrowser.maybeCompleteAuthSession()

type Phase = "loading" | "signedOut" | "signedIn"

type SessionValue = {
  config: AppConfig
  configured: boolean
  phase: Phase
  signingIn: boolean
  /** Changes on every sign-in/sign-out so screens can drop in-memory library content. */
  generation: number
  repository: PlanRepository | null
  signIn(): Promise<void>
  signOut(): Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

const crypto: CryptoProvider = {
  randomBytes: count => Crypto.getRandomBytes(count),
  sha256Base64: input => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, { encoding: Crypto.CryptoEncoding.BASE64 }),
}

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: "PlanManager.WorkOS.Native",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

// SecureStore keys allow only [A-Za-z0-9._-]; scope the record to this client and service.
function storeKey(config: AppConfig): string {
  return `session.${config.clientId}.${config.serviceUrl}`.replace(/[^A-Za-z0-9._-]/g, "_")
}

function parseTokens(value: string | null): Tokens | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<Tokens>
    return typeof parsed.access === "string" && typeof parsed.refresh === "string" ? { access: parsed.access, refresh: parsed.refresh } : null
  } catch { return null }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const config = useMemo(() => readConfig((Constants.expoConfig?.extra ?? {}) as Record<string, unknown>), [])
  const configured = isConfigured(config)
  const key = storeKey(config)
  const [phase, setPhase] = useState<Phase>("loading")
  const [signingIn, setSigningIn] = useState(false)
  const [generation, setGeneration] = useState(0)
  const tokens = useRef<Tokens | null>(null)
  const epoch = useRef(0)
  const refreshing = useRef<Promise<Tokens> | null>(null)

  useEffect(() => {
    if (config.fixtures || !configured) { setPhase("signedOut"); return }
    let cancelled = false
    SecureStore.getItemAsync(key, STORE_OPTIONS)
      .then(value => { if (!cancelled) { tokens.current = parseTokens(value); setPhase(tokens.current ? "signedIn" : "signedOut") } })
      .catch(() => { if (!cancelled) setPhase("signedOut") })
    return () => { cancelled = true }
  }, [config.fixtures, configured, key])

  const persist = useCallback(async (value: Tokens) => {
    await SecureStore.setItemAsync(key, JSON.stringify(value), STORE_OPTIONS)
    tokens.current = value
  }, [key])

  const signOut = useCallback(async () => {
    epoch.current += 1
    WebBrowser.dismissAuthSession()
    refreshing.current = null
    tokens.current = null
    setPhase("signedOut")
    setGeneration(value => value + 1)
    // Local sign-out only: web and CLI sessions are unaffected, and no remote revocation is claimed.
    await SecureStore.deleteItemAsync(key, STORE_OPTIONS)
  }, [key])

  const signIn = useCallback(async () => {
    if (!configured || signingIn) throw new ApiError("unavailable")
    setSigningIn(true)
    const started = epoch.current
    try {
      const pkce = await createPkce(crypto)
      const url = authorizationUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state: pkce.state, challenge: pkce.challenge })
      const result = await WebBrowser.openAuthSessionAsync(url, config.redirectUri, { preferEphemeralSession: true })
      if (result.type !== "success") throw new ApiError("signedOut")
      const code = authorizationCode(result.url, config.redirectUri, pkce.state)
      if (!code) throw new ApiError("signedOut")
      const next = await exchangeCode(fetch, { clientId: config.clientId, code, verifier: pkce.verifier })
      if (started !== epoch.current) throw new ApiError("signedOut")
      await persist(next)
      setPhase("signedIn")
      setGeneration(value => value + 1)
    } finally {
      setSigningIn(false)
    }
  }, [config.clientId, config.redirectUri, configured, persist, signingIn])

  const getToken = useCallback(async (): Promise<string> => {
    const current = tokens.current
    if (!current) throw new ApiError("signedOut")
    if (accessTokenExpiry(current.access) - Date.now() > 60_000) return current.access
    const started = epoch.current
    if (!refreshing.current) {
      refreshing.current = refreshTokens(fetch, { clientId: config.clientId, refresh: current.refresh })
        .then(async next => {
          if (started !== epoch.current) throw new ApiError("signedOut")
          await persist(next)
          return next
        })
        .finally(() => { refreshing.current = null })
    }
    try {
      const next = await refreshing.current
      if (started !== epoch.current) throw new ApiError("signedOut")
      return next.access
    } catch {
      // A rejected refresh token cannot recover; clear it so a fresh sign-in starts cleanly.
      if (started === epoch.current) await signOut().catch(() => undefined)
      throw new ApiError("signedOut")
    }
  }, [config.clientId, persist, signOut])

  const repository = useMemo<PlanRepository | null>(() => {
    if (config.fixtures) return createFixtureRepository()
    if (!configured || phase !== "signedIn") return null
    return createApiRepository({ baseUrl: config.serviceUrl, getToken })
    // generation is a dependency so each session gets a fresh repository instance.
  }, [config.fixtures, config.serviceUrl, configured, getToken, phase, generation])

  const value = useMemo<SessionValue>(
    () => ({ config, configured, phase, signingIn, generation, repository, signIn, signOut }),
    [config, configured, phase, signingIn, generation, repository, signIn, signOut],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession must be used inside SessionProvider")
  return value
}
