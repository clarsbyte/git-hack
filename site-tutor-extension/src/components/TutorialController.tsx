import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, X, AlertTriangle, ScanSearch } from 'lucide-react'
import type { TutorialPayload, TutorialStep, TutorialActionType, StepError } from '../types/tutorial'
import { ActionVerifier } from '../utils/actionVerifier'
import type { ElementIndexer } from '../utils/elementIndexer'
import { saveStepError } from '../utils/tutorialMemory'
// import { findBestElementByInstructionSync } from '../utils/stepElementResolver' // Disabled in manual-only mode
import type { LLMVerifier } from '../utils/llmVerifier'
import type { RouteTracker } from '../utils/routeTracker'

interface TutorialControllerProps {
    tutorial: TutorialPayload
    sessionId?: string | null
    onClose: () => void
    onStepChange?: (index: number) => void
    onComplete?: () => void
    onAdaptiveRecalculate?: () => Promise<boolean> | boolean
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
// const HARD_RELOAD_ROUTE_KEY = 'siteTutor:lastHardReloadRoute' // Disabled in manual-only mode
const INACTIVITY_TIMEOUT_MS = 60000 // 60s inactivity timeout for page transitions
const MANUAL_VERIFY_ONLY = true

const statusCopy: Record<string, string> = {
    waiting: MANUAL_VERIFY_ONLY ? 'Click Verify Step when ready.' : 'Waiting for you to complete this step...',
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
    if (lower.includes('wait for') || lower.includes('observe') || lower.includes('read the') || lower.includes('confirm you')) {
        return 'observe'
    }
    return 'click'
}

const normalizeActionType = (rawActionType: string | undefined, instruction: string): TutorialActionType => {
    const normalized = (rawActionType ?? '').toLowerCase()
    if (normalized === 'click' || normalized === 'input' || normalized === 'wait' || normalized === 'navigate' || normalized === 'scroll' || normalized === 'observe') {
        return normalized
    }
    return inferActionType(instruction)
}

const STOP_WORDS = new Set([
    'click', 'press', 'select', 'choose', 'open', 'go', 'navigate', 'enter', 'type',
    'fill', 'complete', 'continue', 'next', 'previous', 'back', 'button', 'link',
    'the', 'a', 'an', 'to', 'for', 'on', 'of', 'and', 'or', 'with', 'this', 'that',
    'it', 'its', 'your', 'you', 'from', 'in', 'new', 'page', 'section', 'tab'
])

const extractInstructionKeywords = (instruction: string): string[] => {
    const tokens = instruction.toLowerCase().match(/[a-z0-9]+/g) ?? []
    const filtered = tokens.filter(token => token.length >= 3 && !STOP_WORDS.has(token))
    return Array.from(new Set(filtered)).slice(0, 6)
}

// Disabled in manual-only mode
// const routeSignature = (url: string): string => {
//     try {
//         const parsed = new URL(url)
//         return `${parsed.origin}${parsed.pathname}${parsed.search}`
//     } catch {
//         return url.split('#')[0]
//     }
// }

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


const describeTargetElement = (step: TutorialStep): string => {
    if (step.elementIndex == null) return ''
    const indexer = getIndexer()
    const element = indexer?.getElement(step.elementIndex)
    if (!element) return `Element #${step.elementIndex}`

    const tag = element.tagName.toLowerCase()
    const label =
        element.textContent?.trim() ||
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.getAttribute('name') ||
        element.getAttribute('id') ||
        ''

    if (label) {
        const compact = label.replace(/\s+/g, ' ').slice(0, 80)
        return `Element #${step.elementIndex} (${tag} "${compact}")`
    }

    return `Element #${step.elementIndex} (${tag})`
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
    // Import the screenshot helper (dynamic import to avoid circular deps)
    const { hideSiteTutorUI, restoreSiteTutorUI } = await import('../utils/screenshotHelper')

    // Hide Site Tutor UI before capture
    const hiddenState = hideSiteTutorUI()

    try {
        // Wait a frame to ensure UI is hidden
        await new Promise(resolve => requestAnimationFrame(resolve))

        // Try fast Chrome tab capture first (minimizes visible hide duration).
        const tabCapture = await new Promise<Blob | null>((resolve) => {
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
        if (tabCapture) return tabCapture

        // No fallback to desktop capture — desktop screenshots include non-browser
        // content (IDE, terminal, etc.) which confuses the VLM. If captureVisibleTab
        // failed (e.g. tab not focused), skip VLM for this request.
        console.warn('📸 [Site Tutor] captureVisibleTab failed; skipping screenshot (no desktop fallback)')
        return null
    } finally {
        // Always restore UI
        restoreSiteTutorUI(hiddenState)
    }
}

/**
 * DISABLED in manual-only mode
 * Try to resolve the next step's target element on the current page
 * using fuzzy text matching (no backend call needed).
 */
// const tryLocalResolution = (step: TutorialStep): boolean => {
//     const indexer = getIndexer()
//     if (!indexer) return false
//     indexer.indexPage(document)

//     // Try CSS selector
//     if (step.selector) {
//         try {
//             if (document.querySelector(step.selector)) return true
//         } catch { /* invalid selector */ }
//     }

//     // Use shared resolver with specificity scoring
//     const resolved = findBestElementByInstructionSync(step.instruction)
//     return resolved !== null
// }


const TutorialController: React.FC<TutorialControllerProps> = ({
    tutorial,
    sessionId,
    onClose,
    onStepChange,
    onComplete,
    onAdaptiveRecalculate,
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
    const previousStepIndexRef = useRef(initialStepIndex)

    // Page transition tracking
    const lastKnownUrlRef = useRef(window.location.href)
    // const transitionInProgressRef = useRef(false) // Disabled in manual-only mode
    const inactivityTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
    const [showInactivityPrompt, setShowInactivityPrompt] = useState(false)
    const [pollStatus, setPollStatus] = useState<string | null>(null)
    const [isVerifying, setIsVerifying] = useState(false)
    const [verifyResult, setVerifyResult] = useState<{ isCorrect: boolean; reason: string } | null>(null)
    const lastContinueFetchKeyRef = useRef('')
    const lastContinueFetchAtRef = useRef(0)

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

    useEffect(() => {
        previousStepIndexRef.current = currentStepIndex
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
                actionType: normalizeActionType(ps.actionType, ps.instruction),
                selectionReason: `Using plan step #${ps.stepNumber} while real targets load for this page.`,
                isTerminal: Boolean(ps.isTerminal),
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
            const fetchKey = `${window.location.href}::${nextGlobalStepIndex}`
            const now = Date.now()
            if (
                lastContinueFetchKeyRef.current === fetchKey &&
                (now - lastContinueFetchAtRef.current) < 2500
            ) {
                console.log(`⏱️ [Site Tutor] Skip duplicate /continue-tutorial fetch | key=${fetchKey}`)
                return
            }
            lastContinueFetchKeyRef.current = fetchKey
            lastContinueFetchAtRef.current = now

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

            // Capture screenshot for VLM analysis - ensures accurate element targeting
            try {
                const screenshotBlob = await captureScreenshot()
                if (screenshotBlob) {
                    formData.append('screenshot', screenshotBlob, 'screenshot.png')
                    console.log('📸 [Site Tutor] Screenshot captured for VLM analysis')
                } else {
                    console.warn('📸 [Site Tutor] Screenshot capture failed, proceeding without VLM')
                }
            } catch (screenshotError) {
                console.warn('📸 [Site Tutor] Screenshot error:', screenshotError)
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
                const errorText = await response.text().catch(() => '')
                console.warn(`❌ [Site Tutor] /continue-tutorial error ${response.status}: ${errorText}`)
                throw new Error(`Server error: ${response.status} ${errorText}`)
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
                // Capture screenshot for VLM analysis on retry
                try {
                    const retryScreenshotBlob = await captureScreenshot()
                    if (retryScreenshotBlob) {
                        retryForm.append('screenshot', retryScreenshotBlob, 'screenshot.png')
                        console.log('📸 [Site Tutor] Screenshot captured for retry VLM analysis')
                    }
                } catch (screenshotError) {
                    console.warn('📸 [Site Tutor] Screenshot error on retry:', screenshotError)
                }

                const retryResp = await fetchWithTimeout(retryForm)
                console.log(`📡 [Site Tutor] RETRY /continue-tutorial -> status=${retryResp.status}`)
                if (retryResp.ok) {
                    const retryData = await retryResp.json()
                    if (retryData.currentPageHighlights?.length > 0) {
                        console.log(`✅ [Site Tutor] Retry applied | highlights=${retryData.currentPageHighlights.length}`)
                        handleNewPageSteps(retryData, nextGlobalStepIndex)
                        return
                    }
                } else {
                    const retryError = await retryResp.text().catch(() => '')
                    console.warn(`❌ [Site Tutor] RETRY /continue-tutorial error ${retryResp.status}: ${retryError}`)
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
                // Capture screenshot for VLM analysis on final retry
                try {
                    const finalScreenshotBlob = await captureScreenshot()
                    if (finalScreenshotBlob) {
                        finalForm.append('screenshot', finalScreenshotBlob, 'screenshot.png')
                        console.log('📸 [Site Tutor] Screenshot captured for final retry VLM analysis')
                    }
                } catch (screenshotError) {
                    console.warn('📸 [Site Tutor] Screenshot error on final retry:', screenshotError)
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
                } else {
                    const finalError = await finalResp.text().catch(() => '')
                    console.warn(`❌ [Site Tutor] FINAL RETRY /continue-tutorial error ${finalResp.status}: ${finalError}`)
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

    const handleNewPageSteps = useCallback((data: { currentPageHighlights: Array<{ elementIndex?: number; explanation: string; selector?: string; planStepNumber?: number; selectionReason?: string }>; currentPageRange: { startIndex: number; endIndex: number } }, nextGlobalStepIndex: number) => {
        const newHighlights = data.currentPageHighlights ?? []
        const pageRange = data.currentPageRange ?? { startIndex: nextGlobalStepIndex, endIndex: nextGlobalStepIndex }
        const pagePlanSteps = plan?.planSteps.slice(pageRange.startIndex, pageRange.endIndex + 1) ?? []

        // Align highlights to plan step numbers first to avoid carrying targets across steps.
        const normalizedHighlights = newHighlights.map((h) => ({
            elementIndex: typeof h.elementIndex === 'number' ? h.elementIndex : undefined,
            explanation: h.explanation ?? '',
            selector: h.selector ?? '',
            planStepNumber: typeof h.planStepNumber === 'number' ? h.planStepNumber : undefined,
            selectionReason: h.selectionReason ?? '',
        }))

        let newSteps: TutorialStep[] = []
        if (pagePlanSteps.length > 0) {
            const validStepNumbers = new Set(pagePlanSteps.map((step) => step.stepNumber))
            const byStepNumber = new Map<number, typeof normalizedHighlights[number]>()
            const sequential: typeof normalizedHighlights = []

            for (const highlight of normalizedHighlights) {
                const stepNumber = highlight.planStepNumber
                if (typeof stepNumber === 'number' && validStepNumbers.has(stepNumber) && !byStepNumber.has(stepNumber)) {
                    byStepNumber.set(stepNumber, highlight)
                } else {
                    sequential.push(highlight)
                }
            }

            let sequentialCursor = 0
            newSteps = pagePlanSteps.map((planStep) => {
                const alignedHighlight = byStepNumber.get(planStep.stepNumber) ?? sequential[sequentialCursor++]
                return {
                    stepNumber: planStep.stepNumber,
                    selector: alignedHighlight?.selector ?? '',
                    instruction: planStep.instruction,
                    actionType: normalizeActionType(planStep.actionType, planStep.instruction),
                    selectionReason: alignedHighlight?.selectionReason || alignedHighlight?.explanation || '',
                    isTerminal: Boolean(planStep.isTerminal),
                    elementIndex: alignedHighlight?.elementIndex,
                }
            })
        } else {
            // Fallback if plan context is unavailable.
            newSteps = normalizedHighlights.map((h, idx) => {
                const planStepIdx = pageRange.startIndex + idx
                const planStep = plan?.planSteps[planStepIdx]
                return {
                    stepNumber: planStep?.stepNumber ?? (planStepIdx + 1),
                    selector: h.selector ?? '',
                    instruction: planStep?.instruction ?? h.explanation,
                    actionType: normalizeActionType(planStep?.actionType, planStep?.instruction ?? h.explanation),
                    selectionReason: h.selectionReason || h.explanation,
                    isTerminal: Boolean(planStep?.isTerminal),
                    elementIndex: h.elementIndex,
                }
            })
        }

        console.log(`[Site Tutor] Page transition: ${newSteps.length} steps for new page (range ${pageRange.startIndex}-${pageRange.endIndex})`)

        onPageTransitionSteps?.(newSteps, pageRange.startIndex)
        setCurrentStepIndex(0)
        setStatus('waiting')
        setError(null)
    }, [plan, onPageTransitionSteps])

    // ──────────────────────────────────────────────
    // URL change detection DISABLED - Everything is manual via "Verify Step" button
    // Track current URL for AI context but don't auto-trigger transitions
    // ──────────────────────────────────────────────
    useEffect(() => {
        // Update the tracked URL but don't trigger any automatic actions
        lastKnownUrlRef.current = window.location.href

        // DISABLED: Automatic page transition detection - everything is manual now
        // The code below is commented out to prevent automatic URL change handling
        /*
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
                }

                // No hard reload — let the browser navigate naturally and
                // re-index the new page DOM without destroying the content script.
                console.log(`[Site Tutor] Route changed: ${previousUrl} -> ${currentUrl}`)

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
        */
    }, [plan, sessionId, onPageTransitionSteps, planOffset, currentStepIndex, activeStep, steps, isLoadingNewPage, handlePageTransition])

    // ──────────────────────────────────────────────
    // Step navigation
    // ──────────────────────────────────────────────
    const goToNextStep = useCallback(() => {
        const completedStep = steps[currentStepIndex]
        const completedGlobalIndex = planOffset + currentStepIndex
        const isTerminalByPlan = Boolean(plan && completedGlobalIndex >= Math.max(plan.totalSteps - 1, 0))
        const shouldCompleteNow = Boolean(completedStep?.isTerminal || isTerminalByPlan)
        const hasMorePlanSteps = Boolean(plan && (planOffset + totalSteps) < plan.totalSteps)
        const hasAdaptiveRecalculate = Boolean(!plan && onAdaptiveRecalculate)

        if (currentStepIndex === totalSteps - 1 && hasAdaptiveRecalculate) {
            clearAutoAdvance()
            if (isLoadingNewPage) return
            setIsLoadingNewPage(true)
            setStatus('waiting')
            Promise.resolve(onAdaptiveRecalculate?.())
                .then((updated) => {
                    if (!updated) {
                        setStatus('matched')
                        onComplete?.()
                    }
                })
                .catch((error) => {
                    console.warn('[Site Tutor] Adaptive recalculation failed:', error)
                    setStatus('error')
                })
                .finally(() => {
                    setIsLoadingNewPage(false)
                })
            return
        }

        if (shouldCompleteNow) {
            clearAutoAdvance()
            setStatus('matched')
            onComplete?.()
            return
        }

        // DISABLED: Automatic page transition handling - everything is manual via "Verify Step"
        // User must manually verify each step to progress through the tutorial
        if (currentStepIndex === totalSteps - 1 && hasMorePlanSteps && plan) {
            const currentPlanStep = plan.planSteps[completedGlobalIndex]
            if (currentPlanStep?.expectsPageChange) {
                clearAutoAdvance()
                setStatus('waiting')
                return
            }

            // Don't automatically fetch next steps - user must verify manually
            clearAutoAdvance()
            setStatus('waiting')
            return
        }

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
    }, [currentStepIndex, handlePageTransition, isLoadingNewPage, onAdaptiveRecalculate, onComplete, plan, planOffset, steps, totalSteps])

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
        setVerifyResult(null)
        clearAutoAdvance()
        verifierRef.current?.stopWatching()

        // Re-index the page to handle DOM changes between steps
        const indexer = getIndexer()
        if (indexer) {
            indexer.indexPage(document)
        }

        if (MANUAL_VERIFY_ONLY) {
            return
        }

        verifierRef.current?.watchStep(activeStep, getWatchStepOptions())

        // Start inactivity timeout for navigate steps
        if (activeStep.actionType === 'navigate') {
            if (inactivityTimerRef.current) window.clearTimeout(inactivityTimerRef.current)
            setShowInactivityPrompt(false)
            inactivityTimerRef.current = window.setTimeout(() => {
                setShowInactivityPrompt(true)
            }, INACTIVITY_TIMEOUT_MS)
        } else {
            if (inactivityTimerRef.current) {
                window.clearTimeout(inactivityTimerRef.current)
                inactivityTimerRef.current = null
            }
            setShowInactivityPrompt(false)
        }
    }, [activeStep, getWatchStepOptions])

    // ──────────────────────────────────────────────
    // Post-click poll status tracking
    // ──────────────────────────────────────────────
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail
            if (!detail) return
            switch (detail.type) {
                case 'started':
                    setPollStatus('Watching for page changes...')
                    break
                case 'polling':
                    setPollStatus(`Watching... (${Math.round(detail.elapsed / 1000)}s)`)
                    break
                case 'url-changed':
                    setPollStatus('URL changed — advancing!')
                    setTimeout(() => setPollStatus(null), 1000)
                    break
                case 'dom-changed':
                    setPollStatus('Page updated — advancing!')
                    setTimeout(() => setPollStatus(null), 1000)
                    break
                case 'timeout':
                    setPollStatus(null)
                    break
            }
        }
        window.addEventListener('siteTutor:clickPollUpdate', handler)
        return () => window.removeEventListener('siteTutor:clickPollUpdate', handler)
    }, [])

    // ──────────────────────────────────────────────
    // Page/DOM change detection (works for ALL tutorials, even without a plan)
    // When the page shifts, re-index the DOM and restart the step watcher
    // so the verifier can find target elements on the new page.
    // NOTE: We ONLY listen to 'siteTutor:historyChange' here to avoid conflicting
    // with the URL change detection handler above (which listens to 'siteTutor:pageChanged').
    // This prevents duplicate event handling and glitching.
    // ──────────────────────────────────────────────
    useEffect(() => {
        if (!activeStep) return
        if (MANUAL_VERIFY_ONLY) return
        // Skip this handler when we have a plan - the URL change handler above handles it
        if (plan && sessionId && onPageTransitionSteps) return

        const handlePageShift = () => {
            console.log('[Site Tutor] Page shift detected (no plan), re-indexing and restarting watcher')
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

        // Only listen to history changes, not the comprehensive pageChanged event
        // to avoid conflicts with the URL transition handler
        document.addEventListener('siteTutor:historyChange', handlePageShift)

        return () => {
            document.removeEventListener('siteTutor:historyChange', handlePageShift)
        }
    }, [activeStep, startWatchingStep, plan, sessionId, onPageTransitionSteps])

    const retryStep = useCallback(() => {
        setError(null)
        setIsPaused(false)
        startWatchingStep()
    }, [startWatchingStep])

    const verifyCurrentStep = useCallback(async () => {
        if (!activeStep || isVerifying) return

        setIsVerifying(true)
        setVerifyResult(null)
        verifierRef.current?.stopWatching()

        try {
            // Check if URL has changed - if so, re-index the NEW page's DOM
            const currentUrl = window.location.href
            const urlChanged = currentUrl !== lastKnownUrlRef.current

            if (urlChanged) {
                console.log(`🔄 [Site Tutor] URL changed: ${lastKnownUrlRef.current} → ${currentUrl}`)
                console.log('📋 [Site Tutor] Re-indexing DOM for new page...')

                // Update tracked URL
                lastKnownUrlRef.current = currentUrl

                // Re-index the new page to clear old DOM and get fresh elements
                const indexer = getIndexer()
                if (indexer) {
                    indexer.indexPage(document)
                    console.log('✅ [Site Tutor] DOM re-indexed for new page')
                }
            }

            // Capture screenshot
            const screenshotBlob = await captureScreenshot()
            let screenshotBase64: string | undefined
            if (screenshotBlob) {
                screenshotBase64 = await new Promise<string>((resolve) => {
                    const reader = new FileReader()
                    reader.onloadend = () => {
                        const dataUrl = reader.result as string
                        resolve(dataUrl.split(',')[1]) // strip data:...;base64, prefix
                    }
                    reader.readAsDataURL(screenshotBlob)
                })
            }

            // Get current DOM (fresh from new page if URL changed)
            const indexer = getIndexer()
            const domText = indexer?.toTextRepresentation(true) ?? ''

            if (urlChanged) {
                console.log(`📤 [Site Tutor] Sending fresh DOM (${domText.length} chars) from new page`)
            }

            const response = await fetch('http://localhost:8000/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stepInstruction: activeStep.instruction,
                    screenshot: screenshotBase64,
                    dom: domText,
                    clickedElement: '',
                    currentUrl: window.location.href,  // Send current URL so AI knows where user is
                    sessionId: sessionId ?? undefined,
                }),
            })

            const data = await response.json()
            setVerifyResult({ isCorrect: data.isCorrect, reason: data.reason })

            if (data.isCorrect) {
                // Step verified — auto-advance after a short delay
                setStatus('matched')
                clearAutoAdvance()
                autoAdvanceTimeoutRef.current = window.setTimeout(() => {
                    setVerifyResult(null)
                    goToNextStep()
                }, 1500)
            }
        } catch (err) {
            console.error('[Site Tutor] Verify step failed:', err)
            setVerifyResult({ isCorrect: false, reason: 'Verification request failed. Is the backend running?' })
        } finally {
            setIsVerifying(false)
        }
    }, [activeStep, isVerifying, goToNextStep])

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
        if (inactivityTimerRef.current) window.clearTimeout(inactivityTimerRef.current)
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
                            ) : pollStatus ? (
                                <span style={{ color: '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                    <Loader2 size={12} className="animate-spin" />
                                    {pollStatus}
                                </span>
                            ) : (
                                <span style={{ color: '#71717a' }}>
                                    {statusCopy[status] ?? 'Waiting for you to complete this step...'}
                                </span>
                            )}
                        </div>
                        <p className="step-instruction">{activeStep.instruction}</p>
                        {activeStep.elementIndex != null && (
                            <div className="step-selector">
                                Target: <code>{describeTargetElement(activeStep)}</code>
                            </div>
                        )}
                        <details className="step-selector" style={{ marginTop: '10px', opacity: 0.92 }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                                Why this target?
                            </summary>
                            <div style={{ marginTop: '6px' }}>
                                {activeStep.selectionReason || 'No backend explanation provided for this step.'}
                                <br />
                                <span>
                                    Keywords: {extractInstructionKeywords(activeStep.instruction).join(', ') || 'none'}
                                </span>
                                <br />
                                <span>
                                    Control type: {activeStep.actionType}
                                </span>
                                {activeStep.selector && (
                                    <>
                                        <br />
                                        <span>
                                            Fallback selector: <code>{activeStep.selector}</code>
                                        </span>
                                    </>
                                )}
                            </div>
                        </details>
                    </div>

                    {/* Verify Step button + result */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <button
                            onClick={verifyCurrentStep}
                            disabled={isVerifying}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '6px',
                                padding: '8px 16px',
                                borderRadius: '8px',
                                border: '1px solid #3b82f6',
                                background: isVerifying ? '#1e3a5f' : '#2563eb',
                                color: '#fff',
                                fontWeight: 600,
                                fontSize: '13px',
                                cursor: isVerifying ? 'not-allowed' : 'pointer',
                                opacity: isVerifying ? 0.7 : 1,
                                transition: 'all 0.15s ease',
                            }}
                        >
                            {isVerifying ? (
                                <><Loader2 size={14} className="animate-spin" /> Verifying...</>
                            ) : (
                                <><ScanSearch size={14} /> Verify Step</>
                            )}
                        </button>

                        {verifyResult && (
                            <div style={{
                                padding: '8px 12px',
                                borderRadius: '8px',
                                border: `1px solid ${verifyResult.isCorrect ? '#22c55e' : '#ef4444'}`,
                                background: verifyResult.isCorrect ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                                fontSize: '12px',
                                color: verifyResult.isCorrect ? '#86efac' : '#fca5a5',
                            }}>
                                <strong>{verifyResult.isCorrect ? '✓ Step completed!' : '✗ Not yet complete'}</strong>
                                {verifyResult.reason && <p style={{ margin: '4px 0 0', opacity: 0.85 }}>{verifyResult.reason}</p>}
                            </div>
                        )}
                    </div>

                    {showInactivityPrompt && (
                        <div className="error-box" style={{ borderColor: '#f59e0b' }}>
                            <AlertTriangle size={20} style={{ color: '#f59e0b' }} />
                            <div className="error-content">
                                <h4 className="error-title" style={{ color: '#f59e0b' }}>Still waiting for navigation</h4>
                                <p className="error-message">It's been a while. Need help completing this step?</p>
                                <div className="error-actions">
                                    <button onClick={() => { setShowInactivityPrompt(false); retryStep() }} className="retry-btn">
                                        &circlearrowleft; Retry This Step
                                    </button>
                                    <button onClick={cancelTutorial} className="cancel-btn">
                                        End Tutorial
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

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

        </div>
    )
}

export default TutorialController
