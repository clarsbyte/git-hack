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
                this.attachClickListener(step.selector, handleMatch)
                break
            case 'input':
                this.attachInputListener(step.selector, handleMatch)
                break
            case 'navigate':
                this.attachNavigationListener(handleMatch)
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

    private attachClickListener(selector: string, handler: MatchHandler) {
        const listener = (event: MouseEvent) => {
            if (!(event.target instanceof Element)) return
            if (elementMatchesSelector(event.target, selector)) {
                handler()
            }
        }

        document.addEventListener('click', listener, true)
        this.cleanupFns.push(() => document.removeEventListener('click', listener, true))
    }

    private attachInputListener(selector: string, handler: MatchHandler) {
        const listener = (event: Event) => {
            if (!(event.target instanceof Element)) return
            if (!elementMatchesSelector(event.target, selector)) return

            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
                if (event.target.value.trim().length === 0) return
            }

            handler()
        }

        document.addEventListener('input', listener, true)
        document.addEventListener('change', listener, true)
        this.cleanupFns.push(() => {
            document.removeEventListener('input', listener, true)
            document.removeEventListener('change', listener, true)
        })
    }

    private attachNavigationListener(handler: MatchHandler) {
        this.initialUrl = window.location.href
        ensureHistoryEventsPatched()
        const checkUrlChange = () => {
            if (window.location.href !== this.initialUrl) {
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
}
