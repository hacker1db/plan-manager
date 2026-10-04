import type { PlanMetadata, PlanStatus } from './types.js'

const validPlan: PlanMetadata = {
  id: 'plan-id',
  title: 'Typed plan',
  status: 'active',
  created: '2026-07-28T00:00:00.000Z',
  updated: '2026-07-28T00:00:00.000Z',
  tags: ['typed'],
}

const validStatus: PlanStatus = validPlan.status

// @ts-expect-error Plan status values are closed.
const invalidStatus: PlanStatus = 'pending'

void validStatus
void invalidStatus
