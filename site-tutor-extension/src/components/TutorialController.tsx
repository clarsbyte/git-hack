import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, Sparkles, X, AlertTriangle } from 'lucide-react'
import type { TutorialPayload, TutorialStep, StepError } from '../types/tutorial'
import { ActionVerifier } from '../utils/actionVerifier'
import type { ElementIndexer } from '../utils/elementIndexer'
import { saveStepError } from '../utils/tutorialMemory'
import type { LLMVerifier } from '../utils/llmVerifier'
import type { RouteTracker } from '../utils/routeTracker'

interface TutorialControllerProps {
    tutorial: TutorialPayload
    onClose: () => void
    onStepChange?: (index: number) => void
    onComplete?: () => void
    initialStepIndex?: number
    tutorialFingerprint?: string
    llmVerifier?: LLMVerifier | null
    routeTracker?: RouteTracker | null
}

const AUTO_ADVANCE_DELAY = 900

const statusCopy = {
    waiting: 'Waiting for you to complete this step...',
    matched: 'Great! Moving to the next step...',
    hint: 'Having trouble? Use the hint below or click Next to continue.',
    error: 'Something went wrong. Review the error below and retry when ready.',
}

const getIndexer = (): ElementIndexer | undefined => {
    return (window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer
}

const TutorialController: React.FC<TutorialControllerProps> = ({ tutorial, onClose, onStepChange, onComplete, initialStepIndex = 0, tutorialFingerprint, llmVerifier, routeTracker }) => {
    const [currentStepIndex, setCurrentStepIndex] = useState(initialStepIndex)
    const [status, setStatus] = useState<'waiting' | 'matched' | 'hint' | 'error'>('waiting')
    const [hint, setHint] = useState<string | null>(null)
    const [error, setError] = useState<StepError | null>(null)
    const [isPaused, setIsPaused] = useState(false)
    const verifierRef = useRef(new ActionVerifier({
        llmVerifier: llmVerifier || null,
        routeTracker: routeTracker || null
    }))
    const autoAdvanceTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
    const stepAdvanceTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
    const previousStepIndexRef = useRef(initialStepIndex)
    const [showStepAdvance, setShowStepAdvance] = useState(false)

    const steps = tutorial.steps
    const activeStep: TutorialStep | undefined = steps[currentStepIndex]
    const totalSteps = steps.length

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

    const goToNextStep = useCallback(() => {
        clearAutoAdvance()
        setHint(null)
        setStatus('waiting')
        setCurrentStepIndex(prev => {
            const nextIndex = Math.min(prev + 1, totalSteps - 1)
            if (nextIndex === prev && prev === totalSteps - 1) {
                onComplete?.()
            }
            return nextIndex
        })
    }, [onComplete, totalSteps])

    const goToPreviousStep = useCallback(() => {
        clearAutoAdvance()
        setHint(null)
        setStatus('waiting')
        setCurrentStepIndex(prev => Math.max(prev - 1, 0))
    }, [])

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

    const progressLabel = useMemo(() => `Step ${currentStepIndex + 1} of ${totalSteps}`, [currentStepIndex, totalSteps])

    if (!activeStep) return null

    return (
        <div className="flex flex-col gap-4 h-full">
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

            {showStepAdvance && (
                <div className="step-advance-notification" aria-live="polite">
                    <Sparkles size={16} />
                    <span>Step {currentStepIndex + 1} ready! Follow the on-page highlight.</span>
                </div>
            )}

            <div className="step-card">
                <div className="step-status">
                    <span className="step-action-type">
                        <CheckCircle2 size={16} />
                        {activeStep.actionType.toUpperCase()}
                    </span>
                    <span style={{ color: '#d4d4d8' }}>•</span>
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
                                    ↻ Retry This Step
                                </button>
                            )}
                            <button onClick={cancelTutorial} className="cancel-btn">
                                Cancel Tutorial
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="tutorial-nav">
                <button
                    onClick={goToPreviousStep}
                    disabled={currentStepIndex === 0}
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
                    >
                        <AlertCircle size={16} /> Reset watcher
                    </button>
                    <button
                        onClick={goToNextStep}
                        className="nav-btn nav-btn-primary"
                    >
                        {currentStepIndex === totalSteps - 1 ? 'Finish' : 'Next'}
                        <ChevronRight size={16} />
                    </button>
                </div>
            </div>
        </div>
    )
}

export default TutorialController
