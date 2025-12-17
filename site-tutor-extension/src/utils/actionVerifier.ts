import type { TutorialStep } from '../types/tutorial'

type MatchHandler = () => void

type WatchOptions = {
    timeoutMs?: number
    onMatch: MatchHandler
    onTimeout?: () => void
}

const DEFAULT_TIMEOUT = 20000
const NAVIGATION_EVENT = 'siteTutor:navigation'

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

const elementMatchesSelector = (element: Element | null, selector: string): boolean => {
    if (!element) return false
    try {
        if (element.matches(selector)) return true
        const closest = element.closest(selector)
        if (closest) return true
    } catch (err) {
        console.warn('Site Tutor: invalid selector in action verifier', selector, err)
    }
    return false
}

// Try to find an element using various fallback strategies
const findElementWithFallback = (selector: string): Element | null => {
    try {
        // Try direct query first
        const matches = document.querySelectorAll(selector)
        if (matches.length > 0) {
            // Return first visible element
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
        }
    } catch {
        // Invalid selector, continue to fallbacks
    }

    // Try simplified selector (remove pseudo-selectors)
    if (selector.includes(':') || selector.includes('::')) {
        const simplifiedSelector = selector.split(/[:]/)[0]
        try {
            const matches = document.querySelectorAll(simplifiedSelector)
            if (matches.length > 0) {
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
            }
        } catch {
            // Continue to next fallback
        }
    }

    // If looking for an input (checkbox/radio), also search for toggle switches
    if (selector.includes('input#') || selector.includes('input[')) {
        try {
            // Modern UIs often use toggle switches instead of checkboxes
            const toggles = document.querySelectorAll('button[aria-pressed], [role="switch"]')
            for (const el of Array.from(toggles)) {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                if (rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.opacity !== '0') {
                    // Return first visible toggle switch as a fallback
                    console.log('Site Tutor: Using toggle switch as fallback for input selector', { selector, toggle: el })
                    return el
                }
            }
        } catch {
            // Continue
        }
    }

    return null
}

export class ActionVerifier {
    private timeoutId: ReturnType<typeof window.setTimeout> | null = null
    private intervalId: ReturnType<typeof window.setInterval> | null = null
    private cleanupFns: Array<() => void> = []
    private initialUrl = ''

    stopWatching(): void {
        if (this.timeoutId) {
            window.clearTimeout(this.timeoutId)
            this.timeoutId = null
        }
        if (this.intervalId) {
            window.clearInterval(this.intervalId)
            this.intervalId = null
        }
        this.cleanupFns.forEach(fn => fn())
        this.cleanupFns = []
    }

    watchStep(step: TutorialStep, options: WatchOptions): void {
        this.stopWatching()
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT

        if (timeoutMs > 0) {
            this.timeoutId = window.setTimeout(() => {
                this.stopWatching()
                options.onTimeout?.()
            }, timeoutMs)
        }

        const handleMatch = () => {
            this.stopWatching()
            options.onMatch()
        }

        switch (step.actionType) {
            case 'click':
                this.attachClickListener(step.selector, handleMatch, step.expectedResult)
                break
            case 'input':
                this.attachInputListener(step.selector, handleMatch, step.expectedResult)
                break
            case 'navigate':
                this.attachNavigationListener(handleMatch, step.expectedResult)
                break
            case 'wait':
            default: {
                // Wait steps resolve automatically but still honor timeout
                const autoComplete = window.setTimeout(handleMatch, 600)
                this.cleanupFns.push(() => window.clearTimeout(autoComplete))
                break
            }
        }
    }

    private attachClickListener(selector: string, handler: MatchHandler, expectedResult?: string) {
        let clickDetected = false

        // Try to find the target element to validate selector works
        const targetExists = findElementWithFallback(selector)
        if (!targetExists) {
            console.warn('Site Tutor: Target element not found for click listener', { selector })
        }

        const listener = (event: MouseEvent) => {
            if (!(event.target instanceof Element)) return

            // Try exact match first
            let matches = elementMatchesSelector(event.target, selector)

            // If selector doesn't match, check if clicked element could reasonably be what we're looking for
            if (!matches && targetExists) {
                // Check if clicked element is the target or contains it
                matches = event.target === targetExists || event.target.contains(targetExists) || targetExists.contains(event.target)
            }

            if (!matches) return

            console.log('Site Tutor: Click detected on target element', { selector })

            // If expectedResult is provided, verify it before completing step
            if (expectedResult) {
                clickDetected = true
                // Wait a bit for DOM to update after click, then check
                setTimeout(() => {
                    const resultMatches = this.verifyExpectedResult(expectedResult)
                    if (resultMatches) {
                        console.log('Site Tutor: Click action verified - expected result found', { expectedResult })
                        handler()
                    } else {
                        console.log('Site Tutor: Click detected but expected result not found yet', { expectedResult })
                    }
                }, 300)
            } else {
                // No expected result - complete immediately on click
                handler()
            }
        }

        document.addEventListener('click', listener, true)
        this.cleanupFns.push(() => document.removeEventListener('click', listener, true))

        // If expected result is specified, also periodically check for it after click
        if (expectedResult) {
            const checkInterval = window.setInterval(() => {
                if (clickDetected && this.verifyExpectedResult(expectedResult)) {
                    console.log('Site Tutor: Expected result found via periodic check', { expectedResult })
                    handler()
                }
            }, 500)

            this.cleanupFns.push(() => window.clearInterval(checkInterval))
        }
    }

    private attachInputListener(selector: string, handler: MatchHandler, expectedResult?: string) {
        // Try to find the target element to validate selector works
        const targetExists = findElementWithFallback(selector)
        if (!targetExists) {
            console.warn('Site Tutor: Target element not found for input listener', { selector })
        }

        const listener = (event: Event) => {
            if (!(event.target instanceof Element)) return

            // Try exact match first
            let matches = elementMatchesSelector(event.target, selector)

            // If selector doesn't match, check if input element could reasonably be what we're looking for
            if (!matches && targetExists) {
                matches = event.target === targetExists
            }

            if (!matches) return

            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
                if (event.target.value.trim().length === 0) return

                console.log('Site Tutor: Input detected', {
                    selector,
                    value: event.target.value,
                    expectedResult
                })

                // If expectedResult is provided, verify the input value
                if (expectedResult) {
                    const inputValue = event.target.value.toLowerCase()
                    const expectedLower = expectedResult.toLowerCase()

                    if (inputValue.includes(expectedLower) || expectedLower.includes(inputValue)) {
                        console.log('Site Tutor: Input matched expected result', { expectedResult })
                        handler()
                    } else {
                        console.log('Site Tutor: Input detected but does not match expected result yet')
                    }
                } else {
                    // No expected result - complete on any non-empty input
                    handler()
                }
            } else {
                // Non-text input element (checkbox, radio, etc)
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
            const currentUrl = window.location.href

            // Check if URL changed
            if (currentUrl === this.initialUrl) return

            // If expectedResult is provided, validate against it
            if (expectedResult) {
                // Try to match as URL pattern
                const urlMatches = this.urlMatchesPattern(currentUrl, expectedResult)

                if (urlMatches) {
                    console.log('Site Tutor: Navigation matched expected URL pattern', {
                        current: currentUrl,
                        expected: expectedResult
                    })
                    handler()
                    return
                }

                // If URL doesn't match, check if expected element appears in DOM
                const elementAppeared = this.checkExpectedElementAppears(expectedResult)
                if (elementAppeared) {
                    console.log('Site Tutor: Navigation matched - expected element appeared', {
                        expectedResult
                    })
                    handler()
                }
            } else {
                // No expected result - just verify URL changed
                console.log('Site Tutor: Navigation detected (URL changed)', {
                    from: this.initialUrl,
                    to: currentUrl
                })
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

    private urlMatchesPattern(currentUrl: string, pattern: string): boolean {
        // Check for exact match
        if (currentUrl === pattern) return true

        // Check if pattern is contained in URL
        if (currentUrl.includes(pattern)) return true

        // Check if pattern matches path (ignore query params and hash)
        const currentPath = new URL(currentUrl).pathname
        const patternLower = pattern.toLowerCase()
        if (currentPath.toLowerCase().includes(patternLower)) return true

        // Check if pattern is a regex-like pattern
        try {
            const regex = new RegExp(pattern)
            if (regex.test(currentUrl)) return true
        } catch {
            // Not a valid regex, ignore
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
        // Try URL matching first
        if (this.urlMatchesPattern(window.location.href, expectedResult)) {
            return true
        }

        // Try DOM selector matching
        if (this.checkExpectedElementAppears(expectedResult)) {
            return true
        }

        // Try checking if expected text appears in document
        const bodyText = document.body.textContent?.toLowerCase() || ''
        const expectedLower = expectedResult.toLowerCase()
        if (bodyText.includes(expectedLower)) {
            return true
        }

        return false
    }
}
