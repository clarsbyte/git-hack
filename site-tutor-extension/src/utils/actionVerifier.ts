import type { TutorialStep, StepError } from '../types/tutorial'
import type { ElementIndexer } from './elementIndexer'
import { LLMVerifier, type VerificationResponse } from './llmVerifier'
import { RouteTracker } from './routeTracker'
import { elementMatchesInstruction, findBestElementByInstruction } from './stepElementResolver'

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

    const resolved = findBestElementByInstruction(step.instruction)
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
        let clickDetected = false
        const initialUrl = window.location.href

        const targetElement = resolveElement(step)
        if (!targetElement) {
            console.warn('Site Tutor: Target element not found for click listener', { selector: step.selector, elementIndex: step.elementIndex })
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
                // NEW: LLM-based verification flow
                clickDetected = true

                // Wait for page to update
                await new Promise(resolve => setTimeout(resolve, 500))

                // Verify with LLM
                const verification = await this.verifyActionWithLLM(clickedEl, expectedResult)

                if (verification.isCorrect || verification.confidence > 0.7) {
                    handler()
                } else {
                    const options = this.getCurrentOptions()
                    this.handleVerificationFailure(verification, clickedEl, options)
                }
            } else if (expectedResult) {
                // OLD: Local verification fallback
                clickDetected = true
                setTimeout(() => {
                    if (this.matched) return
                    if (this.verifyExpectedResult(expectedResult)) {
                        handler()
                        return
                    }
                    if (window.location.href !== initialUrl) {
                        handler()
                    }
                }, 300)
            } else {
                // No verification needed
                handler()
            }
        }

        document.addEventListener('click', listener, true)
        this.cleanupFns.push(() => document.removeEventListener('click', listener, true))

        if (expectedResult && !this.llmVerifier) {
            // Fallback interval check (only when no LLM)
            const checkInterval = window.setInterval(() => {
                if (this.matched) return
                if (!clickDetected) return
                if (this.verifyExpectedResult(expectedResult) || window.location.href !== initialUrl) {
                    handler()
                }
            }, 500)
            this.cleanupFns.push(() => window.clearInterval(checkInterval))
        }
    }

    private attachInputListener(step: TutorialStep, handler: MatchHandler, expectedResult?: string) {
        const targetElement = resolveElement(step)
        if (!targetElement) {
            console.warn('Site Tutor: Target element not found for input listener', { selector: step.selector, elementIndex: step.elementIndex })
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
                    if (inputValue.includes(expectedLower) || expectedLower.includes(inputValue)) {
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
        if (currentUrl.includes(pattern)) return true

        const currentPath = new URL(currentUrl).pathname
        const patternLower = pattern.toLowerCase()
        if (currentPath.toLowerCase().includes(patternLower)) return true

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
            // Capture fresh screenshot for verification
            const screenshotData = await this.captureScreenshot()

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
            if (screenshotData) {
                formData.append('screenshot', screenshotData)
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

    private async captureScreenshot(): Promise<Blob | null> {
        try {
            // Use Chrome API to capture current tab
            return new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'captureScreen' }, (response) => {
                    if (response?.dataUrl) {
                        // Convert data URL to blob
                        fetch(response.dataUrl)
                            .then(res => res.blob())
                            .then(blob => resolve(blob))
                            .catch(() => resolve(null))
                    } else {
                        resolve(null)
                    }
                })
            })
        } catch {
            return null
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
