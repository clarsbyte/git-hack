import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, Sparkles, X } from 'lucide-react'
import type { TutorialPayload, TutorialStep } from '../types/tutorial'
import { ActionVerifier } from '../utils/actionVerifier'
import type { ElementIndexer } from '../utils/elementIndexer'

interface TutorialControllerProps {
    tutorial: TutorialPayload
    onClose: () => void
    onStepChange?: (index: number) => void
    onComplete?: () => void
    initialStepIndex?: number
    onStepVerify?: (stepIndex: number) => Promise<void>
    isRegenerating?: boolean
}

const AUTO_ADVANCE_DELAY = 900

const statusCopy = {
    waiting: 'Waiting for you to complete this step...',
    matched: 'Great! Moving to the next step...',
    hint: 'Having trouble? Use the hint below or click Next to continue.',
    verifying: 'Verifying step completion...',
}

const getIndexer = (): ElementIndexer | undefined => {
    return (window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer
}

const TutorialController: React.FC<TutorialControllerProps> = ({ tutorial, onClose, onStepChange, onComplete, initialStepIndex = 0, onStepVerify, isRegenerating = false }) => {
    const [currentStepIndex, setCurrentStepIndex] = useState(initialStepIndex)
    const [status, setStatus] = useState<'waiting' | 'matched' | 'hint' | 'verifying'>('waiting')
    const [hint, setHint] = useState<string | null>(null)
    const verifierRef = useRef(new ActionVerifier())
    const autoAdvanceTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
    const stepAdvanceTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
    const previousStepIndexRef = useRef(initialStepIndex)
    const [showStepAdvance, setShowStepAdvance] = useState(false)
    const syncingFromPropRef = useRef(false)

    const steps = tutorial.steps
    const activeStep: TutorialStep | undefined = steps[currentStepIndex]
    const totalSteps = steps.length

    // Sync internal step index from parent props (no queueMicrotask to avoid flicker)
    useEffect(() => {
        syncingFromPropRef.current = true
        setCurrentStepIndex(initialStepIndex)
        setHint(null)
        setStatus('waiting')
        previousStepIndexRef.current = initialStepIndex
    }, [tutorial, initialStepIndex])

    // Notify parent only when step changes internally (not from prop sync)
    useEffect(() => {
        if (syncingFromPropRef.current) {
            syncingFromPropRef.current = false
            return
        }
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
    }, [currentStepIndex])

    const goToNextStep = useCallback(async () => {
        clearAutoAdvance()

        // When verification is provided, let the parent handle everything
        if (onStepVerify) {
            setStatus('verifying')
            try {
                await onStepVerify(currentStepIndex)
            } catch (error) {
                console.error('Step verification error:', error)
            }
            setStatus('waiting')
            // Parent will update tutorial + initialStepIndex, causing re-render
            return
        }

        // No verification — advance normally (old behavior)
        setHint(null)
        setStatus('waiting')
        setCurrentStepIndex(prev => {
            const nextIndex = Math.min(prev + 1, totalSteps - 1)
            if (nextIndex === prev && prev === totalSteps - 1) {
                onComplete?.()
            }
            return nextIndex
        })
    }, [onStepVerify, currentStepIndex, onComplete, totalSteps])

    const goToPreviousStep = useCallback(() => {
        clearAutoAdvance()
        setHint(null)
        setStatus('waiting')
        setCurrentStepIndex(prev => Math.max(prev - 1, 0))
    }, [])

    const startWatchingStep = useCallback(() => {
        if (!activeStep) return
        setHint(null)
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
            }
        })
    }, [activeStep, goToNextStep])

    useEffect(() => {
        const verifier = verifierRef.current
        startWatchingStep()

        return () => {
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

    if (!activeStep) {
        return (
            <div className="flex flex-col gap-4 h-full items-center justify-center">
                <p style={{ color: '#71717a' }}>Loading next step...</p>
                <button onClick={onClose} className="nav-btn">Close tutorial</button>
            </div>
        )
    }

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

            {isRegenerating && (
                <div className="step-advance-notification" aria-live="polite" style={{ backgroundColor: '#3b82f6' }}>
                    <div className="animate-spin" style={{ display: 'inline-block' }}>
                        <CheckCircle2 size={16} />
                    </div>
                    <span>Checking progress and generating next steps...</span>
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

            {hint && (
                <div className="hint-box">
                    <Lightbulb size={16} style={{ marginTop: '2px' }} />
                    <div>
                        <p className="hint-title">Need a hint?</p>
                        <p>{hint}</p>
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
                        disabled={status === 'verifying' || isRegenerating}
                        className="nav-btn nav-btn-primary"
                    >
                        {!onStepVerify && currentStepIndex === totalSteps - 1 ? 'Finish' : 'Next'}
                        <ChevronRight size={16} />
                    </button>
                </div>
            </div>
        </div>
    )
}

export default TutorialController
