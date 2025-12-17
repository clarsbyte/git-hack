import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, Sparkles, X } from 'lucide-react'
import type { TutorialPayload, TutorialStep } from '../types/tutorial'
import { ActionVerifier } from '../utils/actionVerifier'

interface TutorialControllerProps {
    tutorial: TutorialPayload
    onClose: () => void
    onStepChange?: (index: number) => void
    onComplete?: () => void
    initialStepIndex?: number
}

const AUTO_ADVANCE_DELAY = 900

const statusCopy = {
    waiting: 'Waiting for you to complete this step...',
    matched: 'Great! Moving to the next step...',
    timeout: 'Having trouble? Use the hint below or click Next to continue.',
}

const TutorialController: React.FC<TutorialControllerProps> = ({ tutorial, onClose, onStepChange, onComplete, initialStepIndex = 0 }) => {
    const [currentStepIndex, setCurrentStepIndex] = useState(initialStepIndex)
    const [status, setStatus] = useState<'waiting' | 'matched' | 'timeout'>('waiting')
    const [hint, setHint] = useState<string | null>(null)
    const verifierRef = useRef(new ActionVerifier())
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

    const startWatchingStep = useCallback(() => {
        if (!activeStep) return
        setHint(null)
        setStatus('waiting')
        clearAutoAdvance()
        verifierRef.current?.watchStep(activeStep, {
            onMatch: () => {
                setStatus('matched')
                clearAutoAdvance()
                autoAdvanceTimeoutRef.current = window.setTimeout(() => {
                    goToNextStep()
                }, AUTO_ADVANCE_DELAY)
            },
            onTimeout: () => {
                setStatus('timeout')
                setHint(activeStep.hint || activeStep.expectedResult || 'Try following the on-screen instructions closely.')
            }
        })
    }, [activeStep, goToNextStep])

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
            <div className="flex items-start justify-between">
                <div>
                    <p className="text-xs uppercase tracking-wide text-violet-500 font-semibold">Guided Tutorial</p>
                    <h3 className="text-lg font-semibold text-gray-900">{tutorial.title}</h3>
                    <p className="text-sm text-gray-500">{progressLabel}</p>
                </div>
                <button
                    className="text-gray-400 hover:text-gray-600"
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
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 shadow-sm" aria-live="polite">
                    <Sparkles size={16} />
                    <span>Step {currentStepIndex + 1} ready! Follow the on-page highlight.</span>
                </div>
            )}

            <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                    <span className="inline-flex items-center gap-1 text-violet-600 font-medium">
                        <CheckCircle2 size={16} />
                        {activeStep.actionType.toUpperCase()}
                    </span>
                    <span className="text-gray-300">•</span>
                    <span className={status === 'timeout' ? 'text-amber-600' : 'text-gray-500'}>
                        {statusCopy[status]}
                    </span>
                </div>
                <p className="text-base font-medium text-gray-900">{activeStep.instruction}</p>
                {activeStep.expectedResult && (
                    <p className="text-sm text-gray-500">
                        Expected result: <span className="font-medium text-gray-700">{activeStep.expectedResult}</span>
                    </p>
                )}
                <div className="text-xs text-gray-400">
                    Target selector: <code className="text-violet-600">{activeStep.selector}</code>
                </div>
            </div>

            {hint && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                    <Lightbulb size={16} className="mt-0.5" />
                    <div>
                        <p className="font-semibold">Need a hint?</p>
                        <p>{hint}</p>
                    </div>
                </div>
            )}

            <div className="mt-auto flex items-center justify-between gap-3">
                <button
                    onClick={goToPreviousStep}
                    disabled={currentStepIndex === 0}
                    className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 disabled:opacity-40"
                >
                    <ChevronLeft size={16} /> Previous
                </button>
                <div className="flex items-center gap-3">
                    <button
                        className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600"
                        onClick={() => {
                            verifierRef.current?.stopWatching()
                            startWatchingStep()
                        }}
                    >
                        <AlertCircle size={16} /> Reset watcher
                    </button>
                    <button
                        onClick={goToNextStep}
                        className="flex items-center gap-1 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white"
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
