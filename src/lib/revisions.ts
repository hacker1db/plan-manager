// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { computeRevision } from './ids.js'

export async function currentRevision(filePath) {
  const content = await readFile(filePath, 'utf8')
  return computeRevision(content)
}

export async function assertRevision(filePath, supplied) {
  const current = await currentRevision(filePath)
  if (current !== supplied) {
    const err = new Error('Revision conflict')
    err.code = 'ECONFLICT'
    err.currentRevision = current
    err.suppliedRevision = supplied
    throw err
  }
}
