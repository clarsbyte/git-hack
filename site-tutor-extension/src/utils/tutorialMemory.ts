const STORAGE_KEY = 'siteTutor:tutorialHistory'
const MAX_RECORDS = 50
const MAX_AGE_DAYS = 30

export interface StepRecord {
    instruction: string
    completed: boolean
    completedAt?: number
}

export interface TutorialRecord {
    fingerprint: string
    origin: string
    title: string
    query: string
    steps: StepRecord[]
    startedAt: number
    lastAccessedAt: number
    completedAt?: number
    currentStepIndex: number
    originalQuery?: string
    completedStepDescriptions?: string[]
    totalExpectedSteps?: number
}

export function generateFingerprint(origin: string, title: string, steps: string[]): string {
    const raw = `${origin}|${title}|${steps.join('|')}`
    // Simple hash — djb2
    let hash = 5381
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0
    }
    return `fp_${(hash >>> 0).toString(36)}`
}

async function loadAllRecords(): Promise<TutorialRecord[]> {
    if (!chrome?.storage?.local) return []
    return new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
            if (chrome.runtime.lastError) {
                console.warn('tutorialMemory: load error', chrome.runtime.lastError)
                resolve([])
                return
            }
            resolve((result[STORAGE_KEY] as TutorialRecord[] | undefined) ?? [])
        })
    })
}

async function saveAllRecords(records: TutorialRecord[]): Promise<void> {
    if (!chrome?.storage?.local) return
    // Enforce cap
    const trimmed = records.slice(-MAX_RECORDS)
    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: trimmed }, () => {
            if (chrome.runtime.lastError) {
                console.warn('tutorialMemory: save error', chrome.runtime.lastError)
            }
            resolve()
        })
    })
}

export async function saveTutorialRecord(record: TutorialRecord): Promise<void> {
    const records = await loadAllRecords()
    const idx = records.findIndex(r => r.fingerprint === record.fingerprint)
    if (idx >= 0) {
        records[idx] = record
    } else {
        records.push(record)
    }
    await saveAllRecords(records)
}

export async function loadTutorialRecord(fingerprint: string): Promise<TutorialRecord | null> {
    const records = await loadAllRecords()
    const record = records.find(r => r.fingerprint === fingerprint)
    if (!record) return null
    // Discard if older than MAX_AGE_DAYS
    const age = Date.now() - record.lastAccessedAt
    if (age > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return null
    return record
}

export async function findMatchingTutorial(origin: string, query: string): Promise<TutorialRecord | null> {
    const records = await loadAllRecords()
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    if (queryWords.length === 0) return null

    let best: TutorialRecord | null = null
    let bestScore = 0

    for (const record of records) {
        if (record.origin !== origin) continue
        const age = Date.now() - record.lastAccessedAt
        if (age > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) continue

        const titleWords = record.title.toLowerCase().split(/\s+/)
        const queryTerms = record.query.toLowerCase().split(/\s+/)
        const combined = [...titleWords, ...queryTerms]

        let score = 0
        for (const w of queryWords) {
            if (combined.some(c => c.includes(w) || w.includes(c))) {
                score++
            }
        }

        if (score > bestScore) {
            bestScore = score
            best = record
        }
    }

    // Require at least 2 matching words
    return bestScore >= 2 ? best : null
}

export async function markStepCompleted(fingerprint: string, stepIndex: number): Promise<void> {
    const records = await loadAllRecords()
    const record = records.find(r => r.fingerprint === fingerprint)
    if (!record) return

    if (stepIndex >= 0 && stepIndex < record.steps.length) {
        record.steps[stepIndex].completed = true
        record.steps[stepIndex].completedAt = Date.now()
    }

    record.currentStepIndex = stepIndex
    record.lastAccessedAt = Date.now()

    // Check if all steps completed
    if (record.steps.every(s => s.completed)) {
        record.completedAt = Date.now()
    }

    await saveAllRecords(records)
}

export async function getCompletionHistory(origin: string): Promise<{ title: string; completedAt: number }[]> {
    const records = await loadAllRecords()
    return records
        .filter(r => r.origin === origin && r.completedAt)
        .map(r => ({ title: r.title, completedAt: r.completedAt! }))
        .sort((a, b) => b.completedAt - a.completedAt)
}
