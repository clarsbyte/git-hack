import type { TutorialStep, StepError } from '../types/tutorial'
import type { ElementIndexer } from './elementIndexer'
import { LLMVerifier, type VerificationResponse } from './llmVerifier'
import { RouteTracker } from './routeTracker'
import { elementMatchesInstruction, findBestElementByInstructionSync } from './stepElementResolver'

type MatchHandler = () => void
type ErrorHandler = (error: StepError) => void

export type WatchOptions = {
    onMatch: MatchHandler
    onError?: ErrorHandler
}

const NAVIGATION_EVENT = 'siteTutor:navigation'
const DEBOUNCE_MS = 200
const PAGE_STATE_INTERVAL = 2000
const PENDING_NAV_KEY = 'siteTutor:pendingNavigation'
const PENDING_NAV_TTL_MS = 5 * 60 * 1000

type PendingNavigationRecord = {
    stepNumber: number
    expectedResult?: string
    initialUrl: string
    startedAt: number
}

type PendingNavigationStore = Record<string, PendingNavigationRecord>

const getCachedTabId = (): number | null => {
    return (window as typeof window & { __siteTutorTabId?: number | null }).__siteTutorTabId ?? null
}

const getTabId = (): Promise<number | null> => {
    const cached = getCachedTabId()
    if (typeof cached === 'number') return Promise.resolve(cached)
    return new Promise(resolve => {
        try {
            chrome.runtime.sendMessage({ action: 'getTabId' }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve(null)
                    return
                }
                const tabId = typeof response?.tabId === 'number' ? response.tabId : null
                ;(window as typeof window & { __siteTutorTabId?: number | null }).__siteTutorTabId = tabId
                resolve(tabId)
            })
        } catch {
            resolve(null)
        }
    })
}

const loadPendingNavigation = async (): Promise<{ tabId: number; record: PendingNavigationRecord } | null> => {
    if (!chrome?.storage?.local) return null
    const tabId = await getTabId()
    if (tabId === null) return null

    return new Promise(resolve => {
        chrome.storage.local.get([PENDING_NAV_KEY], (result) => {
            if (chrome.runtime.lastError) {
                resolve(null)
                return
            }
            const store = (result[PENDING_NAV_KEY] as PendingNavigationStore | undefined) ?? {}
            const record = store[String(tabId)]
            if (!record) {
                resolve(null)
                return
            }
            if (Date.now() - record.startedAt > PENDING_NAV_TTL_MS) {
                delete store[String(tabId)]
                chrome.storage.local.set({ [PENDING_NAV_KEY]: store }, () => resolve(null))
                return
            }
            resolve({ tabId, record })
        })
    })
}

const savePendingNavigation = async (record: PendingNavigationRecord): Promise<void> => {
    if (!chrome?.storage?.local) return
    const tabId = await getTabId()
    if (tabId === null) return

    chrome.storage.local.get([PENDING_NAV_KEY], (result) => {
        const store = (result[PENDING_NAV_KEY] as PendingNavigationStore | undefined) ?? {}
        store[String(tabId)] = record
        chrome.storage.local.set({ [PENDING_NAV_KEY]: store })
    })
}

const clearPendingNavigation = async (): Promise<void> => {
    if (!chrome?.storage?.local) return
    const tabId = await getTabId()
    if (tabId === null) return

    chrome.storage.local.get([PENDING_NAV_KEY], (result) => {
        const store = (result[PENDING_NAV_KEY] as PendingNavigationStore | undefined) ?? {}
        if (!store[String(tabId)]) return
        delete store[String(tabId)]
        chrome.storage.local.set({ [PENDING_NAV_KEY]: store })
    })
}

const ensureHistoryEventsPatched = () => {
    const globalWindow = window as typeof window & { __siteTutorHistoryPatched?: boolean }
    if (globalWindow.__siteTutorHistoryPatched) return

    const wrap = <K extends 'pushState' | 'replaceState'>(method: K) => {
        const original = window.history[method]
        if (typeof original !== 'function') return

        window.history[method] = (function (this: History, ...args: Parameters<History[K]>) {
            const result = (original as (...innerArgs: Parameters<History[K]>) => ReturnType<History[K]>).apply(this, args)
            window.dispatchEvent(new Event(NAVIGATION_EVENT))
            return result
        }) as History[K]
    }

    wrap('pushState')
    wrap('replaceState')
    globalWindow.__siteTutorHistoryPatched = true
}

const getIndexer = (): ElementIndexer | undefined => {
    return (window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer
}

const elementMatchesSelector = (element: Element | null, selector: string): boolean => {
    if (!element || !selector) return false
    try {
        if (element.matches(selector)) return true
        const closest = element.closest(selector)
        if (closest) return true
    } catch (err) {
        console.warn('Site Tutor: invalid selector in action verifier', selector, err)
    }
    return false
}

const isGenericInputOutcome = (expectedResult: string): boolean => {
    const lower = expectedResult.toLowerCase()
    // Only accept truly specific outcome descriptions, not vague terms
    return (
        lower.includes('contains') ||
        lower.includes('filled') ||
        lower.includes('typed')
    )
}

const WAIT_FOR_ELEMENT_MAX_MS = 3000
const WAIT_FOR_ELEMENT_POLL_MS = 300

/**
 * Poll for an element that may appear after animations, lazy loading, or async renders.
 * Returns the element if found within maxMs, otherwise null.
 */
export const waitForElement = (step: TutorialStep, maxMs: number = WAIT_FOR_ELEMENT_MAX_MS): Promise<Element | null> => {
    return new Promise((resolve) => {
        const el = resolveElement(step)
        if (el) {
            resolve(el)
            return
        }

        const startTime = Date.now()
        const interval = setInterval(() => {
            const el = resolveElement(step)
            if (el) {
                clearInterval(interval)
                resolve(el)
                return
            }
            if (Date.now() - startTime >= maxMs) {
                clearInterval(interval)
                resolve(null)
            }
        }, WAIT_FOR_ELEMENT_POLL_MS)
    })
}

// Resolve element by index first, then selector fallback
const resolveElement = (step: TutorialStep): Element | null => {
    // Primary: element index
    if (step.elementIndex != null) {
        const indexer = getIndexer()
        if (indexer) {
            const el = indexer.getElement(step.elementIndex)
            if (el && elementMatchesInstruction(el, step.instruction)) return el
        }
    }

    // Fallback: CSS selector
    if (step.selector) {
        try {
            const matches = document.querySelectorAll(step.selector)
            for (const el of Array.from(matches)) {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                if (rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.opacity !== '0') {
                    return el
                }
            }
        } catch {
            // Invalid selector
        }

        // Simplified selector
        if (step.selector.includes(':') || step.selector.includes('::')) {
            const simplified = step.selector.split(/[:]/)[0]
            try {
                const matches = document.querySelectorAll(simplified)
                if (matches.length > 0) return matches[0]
            } catch { /* ignore */ }
        }
    }

    const resolved = findBestElementByInstructionSync(step.instruction)
    if (resolved) return resolved

    return null
}

export class ActionVerifier {
    private intervalId: ReturnType<typeof window.setInterval> | null = null
    private cleanupFns: Array<() => void> = []
    private initialUrl = ''
    private matched = false
    private llmVerifier: LLMVerifier | null = null
    private routeTracker: RouteTracker | null = null
    private currentStep: TutorialStep | null = null
    private currentOptions: WatchOptions | null = null

    constructor(options?: { llmVerifier?: LLMVerifier | null; routeTracker?: RouteTracker | null }) {
        this.llmVerifier = options?.llmVerifier || null
        this.routeTracker = options?.routeTracker || null
    }

    private getCurrentOptions(): WatchOptions {
        return this.currentOptions || { onMatch: () => {} }
    }

    stopWatching(): void {
        if (this.intervalId) {
            window.clearInterval(this.intervalId)
            this.intervalId = null
        }
        this.cleanupFns.forEach(fn => fn())
        this.cleanupFns = []
        this.matched = false
    }

    watchStep(step: TutorialStep, options: WatchOptions): void {
        this.stopWatching()
        this.matched = false
        this.currentStep = step
        this.currentOptions = options

        if (step.actionType !== 'navigate') {
            void clearPendingNavigation()
        }

        const handleMatch = () => {
            if (this.matched) return
            this.matched = true
            this.stopWatching()
            options.onMatch()
        }

        switch (step.actionType) {
            case 'click':
                this.attachClickListener(step, handleMatch, step.expectedResult)
                break
            case 'input':
                this.attachInputListener(step, handleMatch, step.expectedResult)
                break
            case 'navigate':
                this.attachNavigationListener(handleMatch, step.expectedResult)
                break
            case 'observe': {
                // Observe steps: show instruction text, auto-complete after a short delay
                // No element highlighting needed
                const observeComplete = window.setTimeout(handleMatch, 2000)
                this.cleanupFns.push(() => window.clearTimeout(observeComplete))
                break
            }
            case 'wait':
            default: {
                const autoComplete = window.setTimeout(handleMatch, 600)
                this.cleanupFns.push(() => window.clearTimeout(autoComplete))
                break
            }
        }

        // Attach outcome observer for expectedResult (MutationObserver-based)
        if (step.expectedResult) {
            this.attachOutcomeObserver(step.expectedResult, handleMatch)
        }

        // Periodic page state check (URL, title, headings) — no API calls
        this.attachPageStateChecker(step.expectedResult, handleMatch)
    }

    private attachClickListener(step: TutorialStep, handler: MatchHandler, expectedResult?: string) {
        const initialUrl = window.location.href

        let targetElement = resolveElement(step)
        if (!targetElement) {
            console.warn('Site Tutor: Target element not found for click listener, starting poll...', { selector: step.selector, elementIndex: step.elementIndex })
            // Fix 3: Wait-for-element polling for dynamic elements
            waitForElement(step).then(el => {
                if (el) {
                    targetElement = el
                    console.log('Site Tutor: Target element found via polling')
                }
            })
        }

        const listener = async (event: MouseEvent) => {
            if (this.matched) return
            if (!(event.target instanceof Element)) return

            let matches = false

            // Primary: match against indexed element
            if (targetElement) {
                matches = event.target === targetElement ||
                          event.target.contains(targetElement) ||
                          targetElement.contains(event.target)
            }

            // Fallback: CSS selector
            if (!matches && step.selector) {
                matches = elementMatchesSelector(event.target, step.selector)
            }

            if (!matches) return

            console.log('Site Tutor: Click detected on target element')

            const clickedEl = event.target as HTMLElement

            if (expectedResult && this.llmVerifier) {
                // LLM-based verification flow
                // Wait for page to update
                await new Promise(resolve => setTimeout(resolve, 500))

                // Verify with LLM
                const verification = await this.verifyActionWithLLM(clickedEl, expectedResult)

                if (verification.isCorrect || verification.confidence > 0.85) {
                    handler()
                } else {
                    const options = this.getCurrentOptions()
                    this.handleVerificationFailure(verification, clickedEl, options)
                }
            } else {
                // Click detected — start persistent URL + DOM polling
                this.startPostClickPolling(initialUrl, expectedResult, handler)
            }
        }

        document.addEventListener('click', listener, true)
        this.cleanupFns.push(() => document.removeEventListener('click', listener, true))
    }

    /**
     * After a click is detected, persistently poll for URL or DOM changes.
     * Fires a custom event so the frontend can track what's happening.
     */
    private startPostClickPolling(
        initialUrl: string,
        _expectedResult: string | undefined,
        handler: MatchHandler
    ): void {
        const initialDomLength = document.body.innerHTML.length
        const POLL_MS = 200
        const MAX_POLL_MS = 15000

        const emit = (detail: { type: string; elapsed: number; from?: string; to?: string }) => {
            window.dispatchEvent(new CustomEvent('siteTutor:clickPollUpdate', { detail }))
        }

        let elapsed = 0
        emit({ type: 'started', elapsed: 0, from: initialUrl })

        const pollInterval = window.setInterval(() => {
            if (this.matched) {
                window.clearInterval(pollInterval)
                return
            }
            elapsed += POLL_MS

            const currentUrl = window.location.href
            const currentDomLength = document.body.innerHTML.length
            const urlChanged = currentUrl !== initialUrl
            const domChanged = Math.abs(currentDomLength - initialDomLength) > 100

            if (urlChanged) {
                emit({ type: 'url-changed', elapsed, from: initialUrl, to: currentUrl })
                window.clearInterval(pollInterval)
                handler()
                return
            }

            if (domChanged) {
                emit({ type: 'dom-changed', elapsed })
                window.clearInterval(pollInterval)
                handler()
                return
            }

            // Periodic heartbeat so frontend knows we're still watching
            if (elapsed % 1000 === 0) {
                emit({ type: 'polling', elapsed })
            }

            if (elapsed >= MAX_POLL_MS) {
                emit({ type: 'timeout', elapsed })
                window.clearInterval(pollInterval)
                handler()
            }
        }, POLL_MS)

        this.cleanupFns.push(() => window.clearInterval(pollInterval))
    }

    private attachInputListener(step: TutorialStep, handler: MatchHandler, expectedResult?: string) {
        let targetElement = resolveElement(step)
        if (!targetElement) {
            console.warn('Site Tutor: Target element not found for input listener, starting poll...', { selector: step.selector, elementIndex: step.elementIndex })
            waitForElement(step).then(el => {
                if (el) {
                    targetElement = el
                    console.log('Site Tutor: Input target element found via polling')
                }
            })
        }

        const listener = (event: Event) => {
            if (this.matched) return
            if (!(event.target instanceof Element)) return

            let matches = false

            if (targetElement) {
                matches = event.target === targetElement
            }

            if (!matches && step.selector) {
                matches = elementMatchesSelector(event.target, step.selector)
            }

            if (!matches) return

            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
                if (event.target.value.trim().length === 0) return

                if (expectedResult) {
                    const inputValue = event.target.value.toLowerCase()
                    const expectedLower = expectedResult.toLowerCase()
                    const valueMatchesOutcome =
                        inputValue.includes(expectedLower) ||
                        expectedLower.includes(inputValue)
                    if (valueMatchesOutcome || isGenericInputOutcome(expectedResult)) {
                        handler()
                    }
                } else {
                    handler()
                }
            } else {
                handler()
            }
        }

        document.addEventListener('input', listener, true)
        document.addEventListener('change', listener, true)
        this.cleanupFns.push(() => {
            document.removeEventListener('input', listener, true)
            document.removeEventListener('change', listener, true)
        })
    }

    private attachNavigationListener(handler: MatchHandler, expectedResult?: string) {
        this.initialUrl = window.location.href
        ensureHistoryEventsPatched()

        const checkUrlChange = () => {
            if (this.matched) return
            const currentUrl = window.location.href
            if (currentUrl === this.initialUrl) return

            if (expectedResult) {
                if (this.urlMatchesPattern(currentUrl, expectedResult)) {
                    handler()
                    return
                }
                if (this.checkExpectedElementAppears(expectedResult)) {
                    handler()
                }
            } else {
                handler()
            }
        }

        const popstateListener = () => checkUrlChange()
        const hashListener = () => checkUrlChange()
        const historyListener = () => checkUrlChange()

        window.addEventListener('popstate', popstateListener)
        window.addEventListener('hashchange', hashListener)
        window.addEventListener(NAVIGATION_EVENT, historyListener)
        this.cleanupFns.push(() => {
            window.removeEventListener('popstate', popstateListener)
            window.removeEventListener('hashchange', hashListener)
            window.removeEventListener(NAVIGATION_EVENT, historyListener)
        })

        this.intervalId = window.setInterval(checkUrlChange, 750)

        void (async () => {
            const pending = await loadPendingNavigation()
            if (!pending) {
                await savePendingNavigation({
                    stepNumber: this.currentStep?.stepNumber ?? 0,
                    expectedResult,
                    initialUrl: this.initialUrl,
                    startedAt: Date.now()
                })
                return
            }

            const { record } = pending
            const currentUrl = window.location.href
            const urlChanged = currentUrl !== record.initialUrl
            const matchesExpected = urlChanged || (expectedResult ? this.verifyExpectedResult(expectedResult) : false)

            if (matchesExpected) {
                await clearPendingNavigation()
                handler()
                return
            }

            await savePendingNavigation({
                stepNumber: this.currentStep?.stepNumber ?? record.stepNumber,
                expectedResult,
                initialUrl: record.initialUrl || this.initialUrl,
                startedAt: record.startedAt
            })
        })()
    }

    private attachOutcomeObserver(expectedResult: string, handler: MatchHandler) {
        // Only use outcome observer for passive action types (wait/navigate)
        // For click/input, we rely ONLY on the specific event listeners
        const isPassiveAction = this.currentStep?.actionType === 'wait' || this.currentStep?.actionType === 'navigate'

        if (!isPassiveAction) {
            // Skip outcome observer for interactive actions
            return
        }

        // Check immediately for passive actions
        if (this.verifyExpectedResult(expectedResult)) {
            // Defer to avoid sync issues
            setTimeout(() => {
                if (!this.matched) handler()
            }, 0)
            return
        }

        let debounceTimer: ReturnType<typeof setTimeout> | null = null

        const observer = new MutationObserver(() => {
            if (this.matched) return
            if (debounceTimer) clearTimeout(debounceTimer)
            debounceTimer = setTimeout(() => {
                if (this.matched) return
                if (this.verifyExpectedResult(expectedResult)) {
                    handler()
                }
            }, DEBOUNCE_MS)
        })

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        })

        this.cleanupFns.push(() => {
            observer.disconnect()
            if (debounceTimer) clearTimeout(debounceTimer)
        })
    }

    private attachPageStateChecker(expectedResult: string | undefined, handler: MatchHandler) {
        let lastUrl = window.location.href
        let lastTitle = document.title

        const check = () => {
            if (this.matched) return

            const currentUrl = window.location.href
            const currentTitle = document.title

            // Detect URL change
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl
                if (expectedResult && this.urlMatchesPattern(currentUrl, expectedResult)) {
                    handler()
                    return
                }
            }

            // Detect title change
            if (currentTitle !== lastTitle) {
                lastTitle = currentTitle
                if (expectedResult) {
                    const expectedLower = expectedResult.toLowerCase()
                    if (currentTitle.toLowerCase().includes(expectedLower)) {
                        handler()
                        return
                    }
                }
            }

            // Check headings for expectedResult
            if (expectedResult) {
                const headings = document.querySelectorAll('h1, h2, h3')
                for (const h of Array.from(headings)) {
                    const text = h.textContent?.toLowerCase() || ''
                    if (text.includes(expectedResult.toLowerCase())) {
                        handler()
                        return
                    }
                }
            }
        }

        const interval = window.setInterval(check, PAGE_STATE_INTERVAL)
        this.cleanupFns.push(() => window.clearInterval(interval))
    }

    private urlMatchesPattern(currentUrl: string, pattern: string): boolean {
        if (currentUrl === pattern) return true

        // Try parsing pattern as a URL for proper comparison
        try {
            const currentParsed = new URL(currentUrl)
            // If pattern looks like a full URL, compare structurally
            if (pattern.startsWith('http://') || pattern.startsWith('https://')) {
                const patternParsed = new URL(pattern)
                return currentParsed.origin === patternParsed.origin &&
                       currentParsed.pathname === patternParsed.pathname
            }

            // Pattern is a path fragment — compare pathname segments, not substrings
            const currentSegments = currentParsed.pathname.split('/').filter(Boolean)
            const patternSegments = pattern.replace(/^\//, '').split('/').filter(Boolean)

            if (patternSegments.length === 0) return false

            // Check if pattern segments appear as contiguous segments in current path
            for (let i = 0; i <= currentSegments.length - patternSegments.length; i++) {
                const allMatch = patternSegments.every((seg, j) =>
                    currentSegments[i + j].toLowerCase() === seg.toLowerCase()
                )
                if (allMatch) return true
            }
        } catch {
            // Not valid URLs, fall through
        }

        // Regex fallback
        try {
            const regex = new RegExp(pattern)
            if (regex.test(currentUrl)) return true
        } catch {
            // Not a valid regex
        }

        return false
    }

    private checkExpectedElementAppears(selector: string): boolean {
        try {
            const elements = document.querySelectorAll(selector)
            return elements.length > 0
        } catch {
            return false
        }
    }

    private verifyExpectedResult(expectedResult: string): boolean {
        if (this.urlMatchesPattern(window.location.href, expectedResult)) {
            return true
        }

        if (this.checkExpectedElementAppears(expectedResult)) {
            return true
        }

        const bodyText = document.body.textContent?.toLowerCase() || ''
        const expectedLower = expectedResult.toLowerCase()
        if (bodyText.includes(expectedLower)) {
            return true
        }

        return false
    }

    /**
     * Verify action using LLM
     */
    private async verifyActionWithLLM(
        clickedElement: HTMLElement,
        expectedResult?: string
    ): Promise<VerificationResponse> {
        // If no expected result, auto-approve
        if (!expectedResult) {
            return {
                isCorrect: true,
                confidence: 1,
                reason: 'No verification required'
            }
        }

        try {
            // Get current DOM index
            const indexer = getIndexer()
            let domText = ""
            if (indexer) {
                indexer.indexPage(document)
                domText = indexer.toTextRepresentation()
            }

            // Send verification request to backend with fresh context
            const formData = new FormData()
            formData.append('stepInstruction', this.currentStep?.instruction || '')
            formData.append('expectedResult', expectedResult)
            formData.append('clickedElement', clickedElement.textContent?.trim() || clickedElement.tagName)
            if (domText) {
                formData.append('dom', domText)
            }

            const response = await fetch('http://localhost:8000/verify', {
                method: 'POST',
                body: formData
            })

            const result = await response.json()
            return {
                isCorrect: result.isCorrect,
                confidence: result.confidence,
                reason: result.reason
            }
        } catch (error) {
            console.error('Verification error:', error)
            // Fallback: accept the action
            return {
                isCorrect: true,
                confidence: 0.5,
                reason: 'Verification unavailable, accepting action'
            }
        }
    }

    /**
     * Handle verification failure
     */
    private handleVerificationFailure(
        verification: VerificationResponse,
        clickedElement: HTMLElement,
        options: WatchOptions
    ): void {
        this.matched = true  // Prevent other listeners from triggering
        this.stopWatching()

        const error: StepError = {
            message: verification.reason,
            expectedAction: this.currentStep?.instruction || '',
            actualAction: `Clicked: ${clickedElement.textContent?.trim() || clickedElement.tagName}`,
            canRetry: true
        }

        options.onError?.(error)
    }

    /**
     * Capture clicked element for memory
     */
    captureClickedElement(element: HTMLElement): any {
        if (this.routeTracker) {
            return this.routeTracker.captureClickedElement(element)
        }
        return null
    }

    /**
     * Get captured element data (for use by TutorialController)
     */
    getLastClickedElementData(): any {
        return this.routeTracker ? this.routeTracker.capturePageState() : null
    }
}
