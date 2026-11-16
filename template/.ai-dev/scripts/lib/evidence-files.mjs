import path from 'node:path'
import { readFile, realpath } from 'node:fs/promises'

export async function readEvidenceFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Invalid evidence path: ${relative}`)
  const absolute = await realpath(path.resolve(root, relative))
  const base = await realpath(root)
  if (!absolute.startsWith(`${base}${path.sep}`)) throw new Error(`Evidence escapes root: ${relative}`)
  return readFile(absolute)
}
