import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Debounce window for coalescing disk writes (ms). */
const SAVE_DEBOUNCE_MS = 200

/**
 * Sidecar sessionId → stable Admin userId index, one JSON object per data file.
 * In-memory map is authoritative for the running process; the file is a
 * restart survival best-effort. Direct index hits only — lineage resolution
 * lives in api-filter (it needs session summaries).
 */
export class OwnershipIndex {
  private readonly map = new Map<string, string>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {
    // Fail-closed load: unreadable or corrupt file starts empty — sessions
    // become admin-only until re-attributed, never cross-visible.
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as { version?: unknown; owners?: Record<string, unknown> }
      // Username-keyed records cannot be mapped safely to Admin IDs.
      if (parsed?.version === 2 && parsed.owners !== null && typeof parsed.owners === 'object') {
        for (const [k, v] of Object.entries(parsed.owners)) {
          if (typeof v === 'string') this.map.set(k, v)
        }
      }
    } catch { /* absent or corrupt: start empty */ }
  }

  record(sessionId: string, userId: string): void {
    this.map.set(sessionId, userId)
    this.scheduleSave()
  }

  lookup(sessionId: string): string | undefined {
    return this.map.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId)
  }

  knownUsernames(): Set<string> {
    return new Set(this.map.values())
  }

  /** All recorded [sessionId, username] pairs (snapshot). */
  entries(): Array<[string, string]> {
    return [...this.map.entries()]
  }

  /** Force the pending save; resolves when the file write settled. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.saving
    await this.writeNow()
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saving = this.writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeNow(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, `${JSON.stringify({ version: 2, owners: Object.fromEntries(this.map) })}\n`, 'utf8')
    } catch { /* persistence is best-effort; memory stays authoritative */ }
  }
}
