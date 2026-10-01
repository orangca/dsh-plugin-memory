import { DEFAULTS, effectiveImportance, makeRecord, shouldArchive } from '../src/lib.js'
const DAY = 86_400_000
const now = Date.now()
const idle = makeRecord({ kind: 'semantic', text: 'x', importance: 0.8, observedAt: now - 365 * DAY })
const used = makeRecord({ kind: 'semantic', text: 'y', importance: 0.8, observedAt: now - 365 * DAY, lastUsedAt: now - DAY })
console.log('idle.eff =', effectiveImportance(idle, now))
console.log('used.eff =', effectiveImportance(used, now))
console.log('ratio    =', effectiveImportance(used, now) / effectiveImportance(idle, now))
console.log('idle.lastUsedAt =', idle.lastUsedAt, ' observedAt age(d) =', (now - idle.observedAt) / DAY)
console.log('archiveAfterDays =', DEFAULTS.archiveAfterDays, 'below =', DEFAULTS.archiveBelowImportance)
console.log('shouldArchive(idle) =', shouldArchive(idle, DEFAULTS, now))
console.log('shouldArchive(used) =', shouldArchive(used, DEFAULTS, now))
