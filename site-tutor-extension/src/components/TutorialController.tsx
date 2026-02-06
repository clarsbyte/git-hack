import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Sparkles, X, AlertTriangle } from 'lucide-react'
import type { TutorialPayload, TutorialStep, TutorialActionType, StepError } from '../types/tutorial'
import { ActionVerifier } from '../utils/actionVerifier'
import type { ElementIndexer } from '../utils/elementIndexer'
import { saveStepError } from '../utils/tutorialMemory'
import type { LLMVerifier } from '../utils/llmVerifier'
import type { RouteTracker } from '../utils/routeTracker'

interface TutorialControllerProps {
    tutorial: TutorialPayload
    sessionId?: string | null
    onClose: () => void
    onStepChange?: (index: number) => void
    onComplete?: () => void
    onPageTransitionSteps?: (newSteps: TutorialStep[], newPlanOffset: number) => void
    initialStepIndex?: number
    tutorialFingerprint?: string
    llmVerifier?: LLMVerifier | null
    routeTracker?: RouteTracker | null
    initialLastUrl?: string
}

const AUTO_ADVANCE_DELAY = 900
const PAGE_TRANSITION_STABILIZE_MS = 800
const PAGE_TRANSITION_TIMEOUT_MS = 12000
const DOM_READY_TIMEOUT_MS = 8000
const DOM_QUIET_TIMEOUT_MS = 5000
const DOM_QUIET_WINDOW_MS = 450
const HARD_RELOAD_ROUTE_KEY = 'siteTutor:lastHardReloadRoute'

const statusCopy: Record<string, string> = {
    waiting: 'Waiting for you to complete this step...',
    matched: 'Great! Moving to the next step...',
    error: 'Something went wrong. Review the error below and retry when ready.',
}

const getIndexer = (): ElementIndexer | undefined => {
    return (window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer
}

const inferActionType = (text: string): TutorialActionType => {
    const lower = text.toLowerCase()
    if (lower.includes('scroll') || lower.includes('down') || lower.includes('to see')) {
        return 'scroll'
    }
    if (lower.includes('type') || lower.includes('enter') || lower.includes('fill')) {
        return 'input'
    }
    if (lower.includes('go to') || lower.includes('navigate') || lower.includes('open')) {
        return 'navigate'
    }
    return 'click'
}

const routeSignature = (url: string): string => {
    try {
        const parsed = new URL(url)
        return `${parsed.origin}${parsed.pathname}${parsed.search}`
    } catch {
        return url.split('#')[0]
    }
}

const waitForDocumentComplete = async (timeoutMs: number = DOM_READY_TIMEOUT_MS): Promise<void> => {
    if (document.readyState === 'complete') return

    await new Promise<void>((resolve) => {
        let settled = false

        const finish = () => {
            if (settled) return
            settled = true
            window.clearTimeout(timeoutId)
            window.removeEventListener('load', finish)
            document.removeEventListener('readystatechange', handleReadyState)
            resolve()
        }

        const handleReadyState = () => {
            if (document.readyState === 'complete') {
                finish()
            }
        }

        const timeoutId = window.setTimeout(finish, timeoutMs)
        window.addEventListener('load', finish, { once: true })
        document.addEventListener('readystatechange', handleReadyState)
    })
}

const waitForDomQuiet = async (
    quietMs: number = DOM_QUIET_WINDOW_MS,
    timeoutMs: number = DOM_QUIET_TIMEOUT_MS
): Promise<void> => {
    await new Promise<void>((resolve) => {
        if (!document.body) {
            resolve()
            return
        }

        let settled = false
        let quietTimer: ReturnType<typeof window.setTimeout> | null = null

        const finish = () => {
            if (settled) return
            settled = true
            if (quietTimer) window.clearTimeout(quietTimer)
            window.clearTimeout(timeoutTimer)
            observer.disconnect()
            resolve()
        }

        const scheduleQuietWindow = () => {
            if (quietTimer) window.clearTimeout(quietTimer)
            quietTimer = window.setTimeout(finish, quietMs)
        }

        const observer = new MutationObserver(() => {
            scheduleQuietWindow()
        })

        const timeoutTimer = window.setTimeout(finish, timeoutMs)
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        })

        scheduleQuietWindow()
    })
}

const scrollToElement = (elementIndex: number): boolean => {
    const indexer = getIndexer()
    if (!indexer) return false

    const el = indexer.getElement(elementIndex)
    if (!el) return false

    try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return true
    } catch (err) {
        console.warn('Failed to scroll to element:', err)
        return false
    }
}

const compressScreenshot = async (dataUrl: string): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            const canvas = document.createElement('canvas')
            const ctx = canvas.getContext('2d')
            if (!ctx) { reject(new Error('No canvas context')); return }
            const maxW = 1920, maxH = 1080
            let w = img.width, h = img.height
            if (w > maxW || h > maxH) {
                const r = Math.min(maxW / w, maxH / h)
                w = Math.floor(w * r); h = Math.floor(h * r)
            }
            canvas.width = w; canvas.height = h
            ctx.drawImage(img, 0, 0, w, h)
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.75)
        }
        img.onerror = () => reject(new Error('Image load failed'))
        img.src = dataUrl
    })
}

const captureScreenshot = async (): Promise<Blob | null> => {
    // Try desktop capture first
    try {
        const resp = await fetch('http://localhost:8000/capture-desktop')
        if (resp.ok) {
            const data = await resp.json()
            const dataUrl = `data:image/png;base64,${data.screenshot}`
            return await compressScreenshot(dataUrl)
        }
    } catch { /* fall through */ }

    // Fallback to Chrome tab capture
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ action: 'captureScreen' }, (response) => {
                if (chrome.runtime.lastError || !response?.dataUrl) {
                    resolve(null)
                    return
                }
                compressScreenshot(response.dataUrl).then(resolve).catch(() => resolve(null))
            })
        } catch {
            resolve(null)
        }
    })
}

/**
 * Try to resolve the next step's target element on the current page
 * using fuzzy text matching (no backend call needed).
 */
const tryLocalResolution = (step: TutorialStep): boolean => {
    const indexer = getIndexer()
    if (!indexer) return false
    indexer.indexPage(document)

    // Try CSS selector
    if (step.selector) {
        try {
            if (document.querySelector(step.selector)) return true
        } catch { /* invalid selector */ }
    }

    // Try instruction-based fuzzy match on interactive elements
    const instruction = step.instruction.toLowerCase()
    const allInteractive = document.querySelectorAll(
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"]'
    )
    const instructionWords = instruction.split(/\s+/).filter(w => w.length > 3)
    if (instructionWords.length === 0) return false

    for (const el of Array.from(allInteractive)) {
        const text = (el.textContent ?? '').toLowerCase()
        const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase()
        const placeholder = (el.getAttribute('placeholder') ?? '').toLowerCase()
        const combined = `${text} ${ariaLabel} ${placeholder}`

        const matchCount = instructionWords.filter(w => combined.includes(w)).length
        if (matchCount >= 2 || (instructionWords.length === 1 && matchCount === 1)) {
            return true
        }
    }

    return false
}


const TutorialController: React.FC<TutorialControllerProps> = ({
    tutorial,
    sessionId,
    onClose,
    onStepChange,
    onComplete,
    onPageTransitionSteps,
    initialStepIndex = 0,
    tutorialFingerprint,
    llmVerifier,
    routeTracker,
    initialLastUrl,
}) => {
    const [currentStepIndex, setCurrentStepIndex] = useState(initialStepIndex)
    const [status, setStatus] = useState<'waiting' | 'matched' | 'error'>('waiting')
    const [error, setError] = useState<StepError | null>(null)
    const [isPaused, setIsPaused] = useState(false)
    const [isLoadingNewPage, setIsLoadingNewPage] = useState(false)
    const verifierRef = useRef(new ActionVerifier({
        llmVerifier: llmVerifier || null,
        routeTracker: routeTracker || null
    }))
    const autoAdvanceTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
    const stepAdvanceTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
    const previousStepIndexRef = useRef(initialStepIndex)
    const [showStepAdvance, setShowStepAdvance] = useState(false)

    // Page transition tracking
    const lastKnownUrlRef = useRef(window.location.href)
    const transitionInProgressRef = useRef(false)

    const steps = tutorial.steps
    const activeStep: TutorialStep | undefined = steps[currentStepIndex]
    const totalSteps = steps.length
    const plan = tutorial.plan
    const planOffset = tutorial.planStepOffset ?? 0

    useEffect(() => {
        if (!initialLastUrl) return
        if (initialLastUrl === lastKnownUrlRef.current) return
        lastKnownUrlRef.current = initialLastUrl
    }, [initialLastUrl])

    useEffect(() => {
        let cancelled = false

        queueMicrotask(() => {
            if (cancelled) return
            if (initialStepIndex === 0) {
                setCurrentStepIndex(0)
                setStatus('waiting')
            } else {
                setCurrentStepIndex(initialStepIndex)
                setStatus('waiting')
            }
            previousStepIndexRef.current = initialStepIndex
        })

        return () => {
            cancelled = true
        }
    }, [tutorial, initialStepIndex])

    useEffect(() => {
        if (typeof onStepChange === 'function') {
            onStepChange(currentStepIndex)
        }
    }, [currentStepIndex, onStepChange])

    const clearAutoAdvance = () => {
        if (autoAdvanceTimeoutRef.current) {
            window.clearTimeout(autoAdvanceTimeoutRef.current)
            autoAdvanceTimeoutRef.current = null
        }
    }

    const clearStepAdvanceFlash = () => {
        if (stepAdvanceTimeoutRef.current) {
            window.clearTimeout(stepAdvanceTimeoutRef.current)
            stepAdvanceTimeoutRef.current = null
        }
    }

    useEffect(() => {
        let cancelled = false

        queueMicrotask(() => {
            if (cancelled) return
            if (currentStepIndex > previousStepIndexRef.current) {
                setShowStepAdvance(true)
                clearStepAdvanceFlash()
                stepAdvanceTimeoutRef.current = window.setTimeout(() => {
                    setShowStepAdvance(false)
                    stepAdvanceTimeoutRef.current = null
                }, 2000)
            } else if (currentStepIndex < previousStepIndexRef.current) {
                setShowStepAdvance(false)
                clearStepAdvanceFlash()
            }

            previousStepIndexRef.current = currentStepIndex
        })

        return () => {
            cancelled = true
        }
    }, [currentStepIndex])

    // ──────────────────────────────────────────────
    // Page transition: pseudo-steps + background fetch
    // ──────────────────────────────────────────────

    /**
     * Immediately show pseudo-steps from the plan while fetching
     * real element indices in the background.
     */
    const showPseudoSteps = useCallback((fromGlobalIndex: number) => {
        if (!plan || !onPageTransitionSteps) return

        // Build pseudo-steps from the plan for the next page
        const pseudoSteps: TutorialStep[] = []
        for (let i = fromGlobalIndex; i < plan.planSteps.length; i++) {
            const ps = plan.planSteps[i]
            // Stop at the first step that expects another page change (that's the next page boundary)
            if (i > fromGlobalIndex && plan.planSteps[i - 1]?.expectsPageChange) break
            pseudoSteps.push({
                stepNumber: ps.stepNumber,
                selector: '',
                instruction: ps.instruction,
                actionType: ps.actionType ?? inferActionType(ps.instruction),
                expectedResult: ps.expectedResult,
                // No elementIndex yet - will be filled in by backend
            })
            // If this step itself expects a page change, include it but stop after
            if (ps.expectsPageChange) break
        }

        if (pseudoSteps.length > 0) {
            console.log(`[Site Tutor] Showing ${pseudoSteps.length} pseudo-steps from plan index ${fromGlobalIndex}`)
            onPageTransitionSteps(pseudoSteps, fromGlobalIndex)
            setCurrentStepIndex(0)
            setStatus('waiting')
            setError(null)
        }
    }, [plan, onPageTransitionSteps])

    /**
     * Fetch real steps with element indices from the backend in the background.
     * Also sends verification data (URL + completed step) for cross-page checking.
     */
    const fetchRealStepsInBackground = useCallback(async (
        nextGlobalStepIndex: number,
        completedStepInstruction?: string
    ) => {
        if (!sessionId || !plan || !onPageTransitionSteps) return

        try {
            console.log(`🚦 [Site Tutor] Transition fetch start | stepIndex=${nextGlobalStepIndex} | url=${window.location.href}`)
            // Wait for full load and post-load DOM settling before indexing.
            await waitForDocumentComplete()
            await waitForDomQuiet()
            await new Promise(resolve => setTimeout(resolve, PAGE_TRANSITION_STABILIZE_MS))

            // Re-index the new page's DOM
            const indexer = getIndexer()
            if (indexer) {
                indexer.indexPage(document)
            }

            // Capture fresh screenshot
            const screenshotBlob = await captureScreenshot()

            // Get fresh DOM text with viewport information
            const domText = indexer?.toTextRepresentation(true) ?? ''
            const viewportSummary = indexer?.getViewportSummary() ?? ''
            console.log(`🧠 [Site Tutor] DOM forwarded to /continue-tutorial | chars=${domText.length}`)

            // Build request with verification data
            const formData = new FormData()
            formData.append('sessionId', sessionId)
            formData.append('currentPlanStepIndex', String(nextGlobalStepIndex))
            formData.append('completedSteps', JSON.stringify(
                Array.from({ length: nextGlobalStepIndex }, (_, i) => i)
            ))
            formData.append('dom', domText)
            formData.append('viewportInfo', viewportSummary)
            formData.append('scrollPosition', String(window.scrollY))
            // Cross-page verification data
            formData.append('currentUrl', window.location.href)
            if (completedStepInstruction) {
                formData.append('completedStepInstruction', completedStepInstruction)
            }

            if (screenshotBlob) {
                formData.append('screenshot', screenshotBlob, 'screenshot.jpg')
            }

            const fetchWithTimeout = async (body: FormData) => {
                const controller = new AbortController()
                const timeoutId = window.setTimeout(() => controller.abort(), PAGE_TRANSITION_TIMEOUT_MS)
                try {
                    return await fetch('http://localhost:8000/continue-tutorial', {
                        method: 'POST',
                        body,
                        signal: controller.signal,
                    })
                } finally {
                    window.clearTimeout(timeoutId)
                }
            }

            const response = await fetchWithTimeout(formData)
            console.log(`📡 [Site Tutor] POST /continue-tutorial -> status=${response.status}`)

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`)
            }

            const data = await response.json()
            const newHighlights = data.currentPageHighlights ?? []
            console.log(`📥 [Site Tutor] /continue-tutorial returned highlights=${newHighlights.length}`)

            if (newHighlights.length === 0) {
                // Retry once after a longer delay
                console.warn('[Site Tutor] No highlights returned for new page, retrying...')
                await new Promise(resolve => setTimeout(resolve, 2000))
                indexer?.indexPage(document)
                const retryDom = indexer?.toTextRepresentation() ?? ''
                const retryForm = new FormData()
                retryForm.append('sessionId', sessionId)
                retryForm.append('currentPlanStepIndex', String(nextGlobalStepIndex))
                retryForm.append('completedSteps', JSON.stringify(
                    Array.from({ length: nextGlobalStepIndex }, (_, i) => i)
                ))
                retryForm.append('dom', retryDom)
                retryForm.append('currentUrl', window.location.href)
                const retryScreenshot = await captureScreenshot()
                if (retryScreenshot) retryForm.append('screenshot', retryScreenshot, 'screenshot.jpg')

                const retryResp = await fetchWithTimeout(retryForm)
                console.log(`📡 [Site Tutor] RETRY /continue-tutorial -> status=${retryResp.status}`)
                if (retryResp.ok) {
                    const retryData = await retryResp.json()
                    if (retryData.currentPageHighlights?.length > 0) {
                        console.log(`✅ [Site Tutor] Retry applied | highlights=${retryData.currentPageHighlights.length}`)
                        handleNewPageSteps(retryData, nextGlobalStepIndex)
                        return
                    }
                }

                // Final fallback: force a full reanalysis cycle and try one last time.
                console.warn('[Site Tutor] Retry returned no highlights, forcing reanalysis and final retry...')
                await new Promise<void>((resolve) => {
                    try {
                        chrome.runtime.sendMessage(
                            { action: 'forceReanalyzeTab', reason: 'continue-tutorial-final-retry' },
                            () => resolve()
                        )
                    } catch {
                        resolve()
                    }
                })
                await waitForDocumentComplete()
                await waitForDomQuiet()
                indexer?.indexPage(document)

                const finalDom = indexer?.toTextRepresentation(true) ?? ''
                const finalViewportSummary = indexer?.getViewportSummary() ?? ''
                const finalForm = new FormData()
                finalForm.append('sessionId', sessionId)
                finalForm.append('currentPlanStepIndex', String(nextGlobalStepIndex))
                finalForm.append('completedSteps', JSON.stringify(
                    Array.from({ length: nextGlobalStepIndex }, (_, i) => i)
                ))
                finalForm.append('dom', finalDom)
                finalForm.append('viewportInfo', finalViewportSummary)
                finalForm.append('scrollPosition', String(window.scrollY))
                finalForm.append('currentUrl', window.location.href)
                if (completedStepInstruction) {
                    finalForm.append('completedStepInstruction', completedStepInstruction)
                }
                const finalScreenshot = await captureScreenshot()
                if (finalScreenshot) {
                    finalForm.append('screenshot', finalScreenshot, 'screenshot.jpg')
                }

                const finalResp = await fetchWithTimeout(finalForm)
                console.log(`📡 [Site Tutor] FINAL RETRY /continue-tutorial -> status=${finalResp.status}`)
                if (finalResp.ok) {
                    const finalData = await finalResp.json()
                    if (finalData.currentPageHighlights?.length > 0) {
                        console.log(`✅ [Site Tutor] Final retry applied | highlights=${finalData.currentPageHighlights.length}`)
                        handleNewPageSteps(finalData, nextGlobalStepIndex)
                        return
                    }
                }

                // Still nothing - pseudo-steps are already showing, just log.
                console.warn('[Site Tutor] Final retry returned no highlights, keeping pseudo-steps')
                return
            }

            handleNewPageSteps(data, nextGlobalStepIndex)
            console.log('✅ [Site Tutor] Transition fetch applied')

        } catch (err) {
            console.error('❌ [Site Tutor] Failed to get steps for new page', err)
            // Pseudo-steps are already showing so the user isn't blocked
            console.warn('[Site Tutor] Keeping pseudo-steps due to backend error')
        }
    }, [sessionId, plan, onPageTransitionSteps])

    const handlePageTransition = useCallback(async (
        nextGlobalStepIndex: number,
        completedStepInstruction?: string
    ) => {
        if (!sessionId || !plan || !onPageTransitionSteps) return

        verifierRef.current?.stopWatching()
        console.log(`🧭 [Site Tutor] handlePageTransition | nextGlobalStepIndex=${nextGlobalStepIndex} | url=${window.location.href}`)

        // Immediately show pseudo-steps from the plan (no loading spinner)
        showPseudoSteps(nextGlobalStepIndex)

        // Fetch real steps with element indices in the background
        setIsLoadingNewPage(true)
        fetchRealStepsInBackground(nextGlobalStepIndex, completedStepInstruction)
            .finally(() => setIsLoadingNewPage(false))
    }, [sessionId, plan, onPageTransitionSteps, showPseudoSteps, fetchRealStepsInBackground])

    const handleNewPageSteps = useCallback((data: { currentPageHighlights: Array<{ elementIndex?: number; explanation: string; selector?: string; planStepNumber?: number }>; currentPageRange: { startIndex: number; endIndex: number } }, nextGlobalStepIndex: number) => {
        const newHighlights = data.currentPageHighlights ?? []
        const pageRange = data.currentPageRange ?? { startIndex: nextGlobalStepIndex, endIndex: nextGlobalStepIndex }

        // Build new TutorialStep[] from the response
        const newSteps: TutorialStep[] = newHighlights.map((h, idx) => {
            const planStepIdx = pageRange.startIndex + idx
            const planStep = plan?.planSteps[planStepIdx]
            return {
                stepNumber: planStep?.stepNumber ?? (planStepIdx + 1),
                selector: h.selector ?? '',
                instruction: planStep?.instruction ?? h.explanation,
                actionType: planStep?.actionType ?? inferActionType(h.explanation),
                expectedResult: planStep?.expectedResult,
                elementIndex: h.elementIndex,
            }
        })

        console.log(`[Site Tutor] Page transition: ${newSteps.length} steps for new page (range ${pageRange.startIndex}-${pageRange.endIndex})`)

        onPageTransitionSteps?.(newSteps, pageRange.startIndex)
        setCurrentStepIndex(0)
        setStatus('waiting')
        setError(null)
    }, [plan, onPageTransitionSteps])

    // ──────────────────────────────────────────────
    // URL change detection for multi-page plans (polls + popstate)
    // ──────────────────────────────────────────────
    useEffect(() => {
        if (!plan || !sessionId || !onPageTransitionSteps) return

        const parseUrl = (value: string): URL | null => {
            try {
                return new URL(value)
            } catch {
                return null
            }
        }

        const checkForPageTransition = () => {
            const currentUrl = window.location.href
            const currentRoute = routeSignature(currentUrl)
            let pendingHardReloadTransition = false
            try {
                pendingHardReloadTransition = sessionStorage.getItem(HARD_RELOAD_ROUTE_KEY) === currentRoute
            } catch {
                pendingHardReloadTransition = false
            }

            if (currentUrl === lastKnownUrlRef.current && !pendingHardReloadTransition) return
            if (transitionInProgressRef.current) return
            if (isLoadingNewPage) return

            const previousUrl = lastKnownUrlRef.current
            const previousParsed = parseUrl(previousUrl)
            const currentParsed = parseUrl(currentUrl)
            const routeChanged = previousParsed && currentParsed
                ? (
                    previousParsed.origin !== currentParsed.origin ||
                    previousParsed.pathname !== currentParsed.pathname
                )
                : previousUrl.split('#')[0] !== currentUrl.split('#')[0]

            lastKnownUrlRef.current = currentUrl
            transitionInProgressRef.current = true

            const currentGlobalStep = planOffset + currentStepIndex
            const currentPlanStep = plan.planSteps[currentGlobalStep]
            const completedInstruction = activeStep?.instruction

            // Was this an expected page change?
            const wasExpected = currentPlanStep?.expectsPageChange === true
            const isNavigateAction = activeStep?.actionType === 'navigate'

            // Force recalculation on real route changes (e.g. "/" -> "/watch/").
            // This avoids getting stuck on stale previous-page local matching.
            if (routeChanged || pendingHardReloadTransition) {
                if (pendingHardReloadTransition) {
                    try {
                        sessionStorage.removeItem(HARD_RELOAD_ROUTE_KEY)
                    } catch {
                        // Ignore removal errors.
                    }
                } else {
                    try {
                        if (sessionStorage.getItem(HARD_RELOAD_ROUTE_KEY) !== currentRoute) {
                            sessionStorage.setItem(HARD_RELOAD_ROUTE_KEY, currentRoute)
                            console.log(`[Site Tutor] Hard reload for new route: ${currentRoute}`)
                            transitionInProgressRef.current = false
                            window.location.reload()
                            return
                        }
                    } catch (err) {
                        console.warn('Site Tutor: hard-reload marker unavailable', err)
                    }
                }

                const nextIndex = (wasExpected || isNavigateAction)
                    ? currentGlobalStep + 1
                    : currentGlobalStep
                handlePageTransition(nextIndex, completedInstruction).finally(() => {
                    transitionInProgressRef.current = false
                })
                return
            }

            if (wasExpected || isNavigateAction) {
                // Expected navigation: current step caused it, move to next
                handlePageTransition(currentGlobalStep + 1, completedInstruction).finally(() => {
                    transitionInProgressRef.current = false
                })
            } else {
                // Unexpected navigation: try local resolution for current step first
                const nextStep = steps[currentStepIndex]
                if (nextStep && tryLocalResolution(nextStep)) {
                    // Current step can still be resolved on new page, just re-index
                    console.log('[Site Tutor] Unexpected navigation but step resolved locally')
                    transitionInProgressRef.current = false
                } else {
                    // Can't resolve locally, re-query backend
                    handlePageTransition(currentGlobalStep, completedInstruction).finally(() => {
                        transitionInProgressRef.current = false
                    })
                }
            }
        }

        const interval = setInterval(checkForPageTransition, 500)
        const handleNavEvent = () => checkForPageTransition()
        // Listen on window for browser events and content-script-world events
        window.addEventListener('popstate', handleNavEvent)
        window.addEventListener('hashchange', handleNavEvent)
        // Listen for the comprehensive page-change event from the content script watcher
        window.addEventListener('siteTutor:pageChanged', handleNavEvent)
        // Listen on document for main-world history changes (cross-world compatible)
        document.addEventListener('siteTutor:historyChange', handleNavEvent)

        return () => {
            clearInterval(interval)
            window.removeEventListener('popstate', handleNavEvent)
            window.removeEventListener('hashchange', handleNavEvent)
            window.removeEventListener('siteTutor:pageChanged', handleNavEvent)
            document.removeEventListener('siteTutor:historyChange', handleNavEvent)
        }
    }, [plan, sessionId, onPageTransitionSteps, planOffset, currentStepIndex, activeStep, steps, isLoadingNewPage, handlePageTransition])

    // ──────────────────────────────────────────────
    // Step navigation
    // ──────────────────────────────────────────────
    const goToNextStep = useCallback(() => {
        clearAutoAdvance()
        setStatus('waiting')
        setCurrentStepIndex(prev => {
            const nextIndex = Math.min(prev + 1, totalSteps - 1)
            if (nextIndex === prev && prev === totalSteps - 1) {
                // Check if there are more plan steps beyond current page
                if (plan && (planOffset + totalSteps) < plan.totalSteps) {
                    // There are more steps on future pages; wait for page transition
                } else {
                    onComplete?.()
                }
            }
            return nextIndex
        })
    }, [onComplete, totalSteps, plan, planOffset])

    const goToPreviousStep = useCallback(() => {
        if (currentStepIndex === 0 && planOffset > 0) {
            return
        }
        clearAutoAdvance()
        setStatus('waiting')
        setCurrentStepIndex(prev => Math.max(prev - 1, 0))
    }, [currentStepIndex, planOffset])

    const cancelTutorial = useCallback(() => {
        setError(null)
        setIsPaused(false)
        onClose()
    }, [onClose])

    const getWatchStepOptions = useCallback(() => ({
        onMatch: () => {
            setStatus('matched')
            clearAutoAdvance()
            autoAdvanceTimeoutRef.current = window.setTimeout(() => {
                goToNextStep()
            }, AUTO_ADVANCE_DELAY)
        },
        onError: (stepError: StepError) => {
            setStatus('error')
            setError(stepError)
            setIsPaused(true)
            clearAutoAdvance()

            // Save error to memory
            if (tutorialFingerprint && activeStep) {
                saveStepError(tutorialFingerprint, activeStep.stepNumber - 1, stepError)
            }
        },
    }), [activeStep, goToNextStep, tutorialFingerprint])

    const startWatchingStep = useCallback(() => {
        if (!activeStep) return
        setError(null)
        setIsPaused(false)
        setStatus('waiting')
        clearAutoAdvance()

        // Re-index the page to handle DOM changes between steps
        const indexer = getIndexer()
        if (indexer) {
            indexer.indexPage(document)
        }

        // Auto-scroll if step requires it or if element is below fold
        if (activeStep.actionType === 'scroll' && activeStep.scrollTarget != null) {
            scrollToElement(activeStep.scrollTarget)
            // Wait for scroll to complete before watching
            setTimeout(() => {
                verifierRef.current?.watchStep(activeStep, getWatchStepOptions())
            }, 500)
            return
        }

        // Check if target element is below scroll and auto-scroll if needed
        if (activeStep.elementIndex != null) {
            const targetEl = indexer?.getElement(activeStep.elementIndex)
            if (targetEl) {
                const rect = targetEl.getBoundingClientRect()
                if (rect.bottom > window.innerHeight) {
                    // Element is below fold, scroll to it
                    scrollToElement(activeStep.elementIndex)
                    // Wait for scroll to complete before watching
                    setTimeout(() => {
                        verifierRef.current?.watchStep(activeStep, getWatchStepOptions())
                    }, 500)
                    return
                }
            }
        }

        verifierRef.current?.watchStep(activeStep, getWatchStepOptions())
    }, [activeStep, getWatchStepOptions])

    // ──────────────────────────────────────────────
    // Page/DOM change detection (works for ALL tutorials, even without a plan)
    // When the page shifts, re-index the DOM and restart the step watcher
    // so the verifier can find target elements on the new page.
    // ──────────────────────────────────────────────
    useEffect(() => {
        if (!activeStep) return

        const handlePageShift = () => {
            console.log('[Site Tutor] Page shift detected, re-indexing and restarting watcher')
            const indexer = getIndexer()
            if (indexer) {
                indexer.indexPage(document)
            }
            // Restart the watcher for the current step on the new DOM
            verifierRef.current?.stopWatching()
            // Small delay to let DOM settle after the shift
            setTimeout(() => {
                startWatchingStep()
            }, 400)
        }

        window.addEventListener('siteTutor:pageChanged', handlePageShift)
        document.addEventListener('siteTutor:historyChange', handlePageShift)

        return () => {
            window.removeEventListener('siteTutor:pageChanged', handlePageShift)
            document.removeEventListener('siteTutor:historyChange', handlePageShift)
        }
    }, [activeStep, startWatchingStep])

    const retryStep = useCallback(() => {
        setError(null)
        setIsPaused(false)
        startWatchingStep()
    }, [startWatchingStep])

    useEffect(() => {
        let cancelled = false
        const verifier = verifierRef.current

        queueMicrotask(() => {
            if (cancelled) return
            startWatchingStep()
        })

        return () => {
            cancelled = true
            verifier?.stopWatching()
            clearAutoAdvance()
        }
    }, [startWatchingStep])

    useEffect(() => () => {
        verifierRef.current?.stopWatching()
        clearAutoAdvance()
        clearStepAdvanceFlash()
    }, [])

    if (!activeStep && !isLoadingNewPage) return null

    return (
        <div className="tutorial-scroll flex flex-col gap-4">
            <div className="tutorial-header">
                <div>
                    <p className="tutorial-badge">Guided Tutorial</p>
                    <h3 className="tutorial-title">{tutorial.title}</h3>
                </div>
                <button
                    className="tutorial-close-btn"
                    onClick={() => {
                        verifierRef.current?.stopWatching()
                        clearAutoAdvance()
                        onClose()
                    }}
                    aria-label="Close tutorial"
                >
                    <X size={18} />
                </button>
            </div>

            {showStepAdvance && !isLoadingNewPage && (
                <div className="step-advance-notification" aria-live="polite">
                    <Sparkles size={16} />
                    <span>Next step ready! Follow the on-page highlight.</span>
                </div>
            )}

            {activeStep ? (
                <>
                    <div className="step-card">
                        <div className="step-status">
                            <span className="step-action-type">
                                <CheckCircle2 size={16} />
                                {activeStep.actionType.toUpperCase()}
                            </span>
                            <span style={{ color: '#d4d4d8' }}>&bull;</span>
                            {isLoadingNewPage ? (
                                <span style={{ color: '#71717a', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                    <Loader2 size={12} className="animate-spin" />
                                    Finding element on page...
                                </span>
                            ) : (
                                <span style={{ color: '#71717a' }}>
                                    {statusCopy[status] ?? 'Waiting for you to complete this step...'}
                                </span>
                            )}
                        </div>
                        <p className="step-instruction">{activeStep.instruction}</p>
                        {activeStep.expectedResult && (
                            <p className="step-expected">
                                Expected result: <span className="step-expected-value">{activeStep.expectedResult}</span>
                            </p>
                        )}
                        {activeStep.elementIndex != null && (
                            <div className="step-selector">
                                Target: <code>Element #{activeStep.elementIndex}</code>
                            </div>
                        )}
                    </div>

                    {error && isPaused && (
                        <div className="error-box">
                            <AlertTriangle size={20} className="error-icon" />
                            <div className="error-content">
                                <h4 className="error-title">Wrong Action Detected</h4>
                                <p className="error-message">{error.message}</p>
                                <div className="error-details">
                                    <div>
                                        <strong>Expected:</strong>
                                        <p>{error.expectedAction}</p>
                                    </div>
                                    <div>
                                        <strong>What happened:</strong>
                                        <p>{error.actualAction}</p>
                                    </div>
                                </div>
                                <div className="error-actions">
                                    {error.canRetry && (
                                        <button onClick={retryStep} className="retry-btn">
                                            &circlearrowleft; Retry This Step
                                        </button>
                                    )}
                                    <button onClick={cancelTutorial} className="cancel-btn">
                                        Cancel Tutorial
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </>
            ) : isLoadingNewPage ? (
                <div className="step-card" style={{ textAlign: 'center', padding: '20px' }}>
                    <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto 8px', display: 'block' }} />
                    <p style={{ color: '#a1a1aa', margin: 0 }}>Loading steps for new page...</p>
                </div>
            ) : null}

            <div className="tutorial-nav">
                <button
                    onClick={goToPreviousStep}
                    disabled={currentStepIndex === 0 && planOffset === 0}
                    className="nav-btn"
                >
                    <ChevronLeft size={16} /> Previous
                </button>
                <div className="nav-right">
                    <button
                        className="nav-btn"
                        onClick={() => {
                            verifierRef.current?.stopWatching()
                            startWatchingStep()
                        }}
                        disabled={isLoadingNewPage}
                    >
                        <AlertCircle size={16} /> Reset watcher
                    </button>
                    <button
                        onClick={goToNextStep}
                        className="nav-btn nav-btn-primary"
                        disabled={isLoadingNewPage}
                    >
                        {currentStepIndex === totalSteps - 1 && (!plan || (planOffset + totalSteps) >= plan.totalSteps) ? 'Finish' : 'Next'}
                        <ChevronRight size={16} />
                    </button>
                </div>
            </div>
        </div>
    )
}

export default TutorialController
