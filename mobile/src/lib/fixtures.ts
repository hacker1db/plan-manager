import { ApiError, type PlanRepository } from "./api"
import type { Plan } from "./shared"

const SAMPLE: Plan = {
  id: "fixture_plan",
  title: "Review the mobile app",
  status: "active",
  tags: ["Expo"],
  created: "2026-11-12",
  updated: "2026-11-12",
  revision: "a".repeat(64),
}

/** Labeled offline sample data. Never contacts the hosted service. */
export function createFixtureRepository(): PlanRepository {
  let current = SAMPLE
  let counter = 0
  return {
    async library() { return [current] },
    async document() {
      return {
        version: 1,
        plan: current,
        html: "<h1>Mobile review</h1><p>This is fixture data. No hosted library is connected.</p><h2>Validation</h2><ul><li>Read on iPhone and iPad</li><li>Review before changing status</li></ul><pre><code>graph TD; Read--&gt;Review</code></pre>",
        headings: [],
        statusUnavailableReason: null,
      }
    },
    async setStatus(plan, status) {
      if (plan.revision !== current.revision) throw new ApiError("conflict")
      counter += 1
      current = { ...current, status, revision: counter.toString(16).padStart(64, "0") }
      return current
    },
  }
}
