import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import type { AnnotationDraft } from "./annotations"

type DraftsValue = {
  draft(planId: string): AnnotationDraft | null
  save(draft: AnnotationDraft): void
  clear(planId: string): void
}

const DraftsContext = createContext<DraftsValue | null>(null)

/**
 * In-memory comment drafts, one per plan. Mount it keyed by the session generation so drafts,
 * like the rest of the library content, are dropped on sign-out and never written to disk.
 */
export function DraftsProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, AnnotationDraft>>({})
  const draft = useCallback((planId: string) => drafts[planId] ?? null, [drafts])
  const save = useCallback((value: AnnotationDraft) => {
    setDrafts(current => {
      if (value.items.length === 0) {
        const { [value.planId]: _removed, ...rest } = current
        return rest
      }
      return { ...current, [value.planId]: value }
    })
  }, [])
  const clear = useCallback((planId: string) => setDrafts(({ [planId]: _removed, ...rest }) => rest), [])
  const value = useMemo(() => ({ draft, save, clear }), [draft, save, clear])
  return <DraftsContext.Provider value={value}>{children}</DraftsContext.Provider>
}

export function useDrafts(): DraftsValue {
  const value = useContext(DraftsContext)
  if (!value) throw new Error("useDrafts must be used inside DraftsProvider")
  return value
}
