import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, Loader2, Sparkles, X, AlertTriangle } from 'lucide-react'
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

const statusCopy = {
    waiting: 'Waiting for you to complete this step...',
    matched: 'Great! Moving to the next step...',
    hint: 'Having trouble? Use the hint below or click Next to continue.',
    error: 'Something went wrong. Review the error below and retry when ready.',
}

const getIndexer = (): ElementIndexer | undefined => {
    return (window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer
}

const inferActionType = (text: string): TutorialActionType => {
    const lower = text.toLowerCase()
    if (lower.includes('type') || lower.includes('enter') || lower.includes('fill')) {
        return 'input'
    }
    if (lower.includes('go to') || lower.includes('navigate') || lower.includes('open')) {
        return 'navigate'
    }
    return 'click'
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
    const [status, setStatus] = useState<'waiting' | 'matched' | 'hint' | 'error'>('waiting')
    const [hint, setHint] = useState<string | null>(null)
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

    // Global progress: show plan-level progress if plan exists
    const globalStepIndex = planOffset + currentStepIndex
    const totalPlanSteps = plan?.totalSteps ?? totalSteps

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
                setHint(null)
                setStatus('waiting')
            } else {
                setCurrentStepIndex(initialStepIndex)
                setHint(null)
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
    // Page transition: call /continue-tutorial
    // ──────────────────────────────────────────────
    const handlePageTransition = useCallback(async (nextGlobalStepIndex: number) => {
        if (!sessionId || !plan || !onPageTransitionSteps) return

        setIsLoadingNewPage(true)
        verifierRef.current?.stopWatching()

        try {
            // Wait for new page DOM to stabilize
            await new Promise(resolve => setTimeout(resolve, PAGE_TRANSITION_STABILIZE_MS))

            // Re-index the new page's DOM
            const indexer = getIndexer()
            if (indexer) {
                indexer.indexPage(document)
            }

            // Capture fresh screenshot
            const screenshotBlob = await captureScreenshot()

            // Get fresh DOM text
            const domText = indexer?.toTextRepresentation() ?? ''

            // Build request
            const formData = new FormData()
            formData.append('sessionId', sessionId)
            formData.append('currentPlanStepIndex', String(nextGlobalStepIndex))
            formData.append('completedSteps', JSON.stringify(
                Array.from({ length: nextGlobalStepIndex }, (_, i) => i)
            ))
            formData.append('dom', domText)

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

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`)
            }

            const data = await response.json()
            const newHighlights = data.currentPageHighlights ?? []

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
                const retryScreenshot = await captureScreenshot()
                if (retryScreenshot) retryForm.append('screenshot', retryScreenshot, 'screenshot.jpg')

                const retryResp = await fetchWithTimeout(retryForm)
                if (retryResp.ok) {
                    const retryData = await retryResp.json()
                    if (retryData.currentPageHighlights?.length > 0) {
                        return handleNewPageSteps(retryData, nextGlobalStepIndex)
                    }
                }

                // Still nothing - let user advance manually
                setHint('Could not identify elements on this page. Follow the instructions and advance manually.')
                setStatus('hint')
                return
            }

            handleNewPageSteps(data, nextGlobalStepIndex)

        } catch (err) {
            console.error('Site Tutor: Failed to get steps for new page', err)
            setStatus('hint')
            setHint('Page changed but could not load new step details. Follow the instructions and click Next to advance manually.')
        } finally {
            setIsLoadingNewPage(false)
        }
    }, [sessionId, plan, onPageTransitionSteps])

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
                hint: planStep?.hint,
                elementIndex: h.elementIndex,
            }
        })

        console.log(`[Site Tutor] Page transition: ${newSteps.length} steps for new page (range ${pageRange.startIndex}-${pageRange.endIndex})`)

        onPageTransitionSteps?.(newSteps, pageRange.startIndex)
        setCurrentStepIndex(0)
        setStatus('waiting')
        setHint(null)
        setError(null)
    }, [plan, onPageTransitionSteps])

    // ──────────────────────────────────────────────
    // URL change detection (polls + popstate)
    // ──────────────────────────────────────────────
    useEffect(() => {
        if (!plan || !sessionId || !onPageTransitionSteps) return

        const checkForPageTransition = () => {
            const currentUrl = window.location.href
            if (currentUrl === lastKnownUrlRef.current) return
            if (transitionInProgressRef.current) return
            if (isLoadingNewPage) return

            lastKnownUrlRef.current = currentUrl
            transitionInProgressRef.current = true

            const currentGlobalStep = planOffset + currentStepIndex
            const currentPlanStep = plan.planSteps[currentGlobalStep]

            // Was this an expected page change?
            const wasExpected = currentPlanStep?.expectsPageChange === true
            const isNavigateAction = activeStep?.actionType === 'navigate'

            if (wasExpected || isNavigateAction) {
                // Expected navigation: current step caused it, move to next
                handlePageTransition(currentGlobalStep + 1).finally(() => {
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
                    handlePageTransition(currentGlobalStep).finally(() => {
                        transitionInProgressRef.current = false
                    })
                }
            }
        }

        const interval = setInterval(checkForPageTransition, 500)
        const handlePopState = () => checkForPageTransition()
        window.addEventListener('popstate', handlePopState)

        return () => {
            clearInterval(interval)
            window.removeEventListener('popstate', handlePopState)
        }
    }, [plan, sessionId, onPageTransitionSteps, planOffset, currentStepIndex, activeStep, steps, isLoadingNewPage, handlePageTransition])

    // ──────────────────────────────────────────────
    // Step navigation
    // ──────────────────────────────────────────────
    const goToNextStep = useCallback(() => {
        clearAutoAdvance()
        setHint(null)
        setStatus('waiting')
        setCurrentStepIndex(prev => {
            const nextIndex = Math.min(prev + 1, totalSteps - 1)
            if (nextIndex === prev && prev === totalSteps - 1) {
                // Check if there are more plan steps beyond current page
                if (plan && (planOffset + totalSteps) < plan.totalSteps) {
                    // There are more steps on future pages; wait for page transition
                    setHint('Complete this step to navigate to the next page.')
                } else {
                    onComplete?.()
                }
            }
            return nextIndex
        })
    }, [onComplete, totalSteps, plan, planOffset])

    const goToPreviousStep = useCallback(() => {
        if (currentStepIndex === 0 && planOffset > 0) {
            setHint('To go back, navigate to the previous page in your browser, then click Previous again.')
            return
        }
        clearAutoAdvance()
        setHint(null)
        setStatus('waiting')
        setCurrentStepIndex(prev => Math.max(prev - 1, 0))
    }, [currentStepIndex, planOffset])

    const cancelTutorial = useCallback(() => {
        setError(null)
        setIsPaused(false)
        onClose()
    }, [onClose])

    const startWatchingStep = useCallback(() => {
        if (!activeStep) return
        setHint(null)
        setError(null)
        setIsPaused(false)
        setStatus('waiting')
        clearAutoAdvance()

        // Re-index the page to handle DOM changes between steps
        const indexer = getIndexer()
        if (indexer) {
            indexer.indexPage(document)
        }

        verifierRef.current?.watchStep(activeStep, {
            onMatch: () => {
                setStatus('matched')
                clearAutoAdvance()
                autoAdvanceTimeoutRef.current = window.setTimeout(() => {
                    goToNextStep()
                }, AUTO_ADVANCE_DELAY)
            },
            onHintReady: () => {
                setStatus('hint')
                setHint(activeStep.hint || activeStep.expectedResult || 'Try following the on-screen instructions closely.')
            },
            onError: (stepError) => {
                setStatus('error')
                setError(stepError)
                setIsPaused(true)
                clearAutoAdvance()

                // Save error to memory
                if (tutorialFingerprint) {
                    saveStepError(tutorialFingerprint, activeStep.stepNumber - 1, stepError)
                }
            },
            onProgress: (msg) => {
                setHint(msg)
            }
        })
    }, [activeStep, goToNextStep, tutorialFingerprint])

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

    const progressLabel = useMemo(
        () => `Step ${globalStepIndex + 1} of ${totalPlanSteps}`,
        [globalStepIndex, totalPlanSteps]
    )

    if (!activeStep && !isLoadingNewPage) return null

    return (
        <div className="tutorial-scroll flex flex-col gap-4">
            <div className="tutorial-header">
                <div>
                    <p className="tutorial-badge">Guided Tutorial</p>
                    <h3 className="tutorial-title">{tutorial.title}</h3>
                    <p className="tutorial-progress">{progressLabel}</p>
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
                    <span>Step {globalStepIndex + 1} ready! Follow the on-page highlight.</span>
                </div>
            )}

            {isLoadingNewPage ? (
                <div className="step-card" style={{ textAlign: 'center', padding: '20px' }}>
                    <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto 8px', display: 'block' }} />
                    <p style={{ color: '#a1a1aa', margin: 0 }}>Loading steps for new page...</p>
                </div>
            ) : activeStep ? (
                <>
                    <div className="step-card">
                        <div className="step-status">
                            <span className="step-action-type">
                                <CheckCircle2 size={16} />
                                {activeStep.actionType.toUpperCase()}
                            </span>
                            <span style={{ color: '#d4d4d8' }}>&bull;</span>
                            <span style={{ color: status === 'hint' ? '#d97706' : '#71717a' }}>
                                {statusCopy[status]}
                            </span>
                        </div>
                        <p className="step-instruction">{activeStep.instruction}</p>
                        {activeStep.expectedResult && (
                            <p className="step-expected">
                                Expected result: <span className="step-expected-value">{activeStep.expectedResult}</span>
                            </p>
                        )}
                        <div className="step-selector">
                            Target: <code>{activeStep.elementIndex != null ? `Element #${activeStep.elementIndex}` : activeStep.selector}</code>
                        </div>
                    </div>

                    {hint && !isPaused && (
                        <div className="hint-box">
                            <Lightbulb size={16} style={{ marginTop: '2px' }} />
                            <div>
                                <p className="hint-title">Need a hint?</p>
                                <p>{hint}</p>
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
