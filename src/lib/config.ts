import { homedir } from 'node:os'
import { join } from 'node:path'

export function getPlanHome(): string {
  return process.env.PLAN_HOME ?? join(homedir(), 'notes', 'SecondBrain', '4.Resources', 'plans')
}

export function getPort(): number {
  const v = process.env.PLAN_PORT
  return v ? parseInt(v, 10) : 4173
}

export function getHost(): string {
  return process.env.PLAN_HOST ?? '127.0.0.1'
}
