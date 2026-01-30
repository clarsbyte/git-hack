import type { TutorialStep } from '../types/tutorial'
import type { ElementIndexer } from './elementIndexer'

type MatchHandler = () => void

export type WatchOptions = {
    hintDelayMs?: number
    onMatch: MatchHandler
    onHintReady?: () => void
}

const DEFAULT_HINT_DELAY = 15000
const NAVIGATION_EVENT = 'siteTutor:navigation'
const DEBOUNCE_MS = 200
const PAGE_STATE_INTERVAL = 2000

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
            if (el) return el
        }
    }

    // Fallback: CSS selector
    if (!step.selector) return null
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

    return null
}

export class ActionVerifier {
    private hintTimeoutId: ReturnType<typeof window.setTimeout> | null = null
    private intervalId: ReturnType<typeof window.setInterval> | null = null
    private cleanupFns: Array<() => void> = []
    private initialUrl = ''
    private matched = false

    stopWatching(): void {
        if (this.hintTimeoutId) {
            window.clearTimeout(this.hintTimeoutId)
            this.hintTimeoutId = null
        }
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

        const hintDelayMs = options.hintDelayMs ?? DEFAULT_HINT_DELAY

        // Hint timer — fires once but does NOT stop watching
        if (hintDelayMs > 0 && options.onHintReady) {
            this.hintTimeoutId = window.setTimeout(() => {
                if (!this.matched) {
                    options.onHintReady?.()
                }
            }, hintDelayMs)
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

        const listener = (event: MouseEvent) => {
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

            if (expectedResult) {
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
                handler()
            }
        }

        document.addEventListener('click', listener, true)
        this.cleanupFns.push(() => document.removeEventListener('click', listener, true))

        if (expectedResult) {
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
    }

    private attachOutcomeObserver(expectedResult: string, handler: MatchHandler) {
        // Check immediately in case outcome already exists
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
}
