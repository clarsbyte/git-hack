import React, { useState, useRef, useEffect, useCallback } from 'react'
import { MessageCircle, X, Send, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Overlay from './Overlay'
import TutorialController from './TutorialController'
import type { TutorialActionType, TutorialPayload, TutorialPlan, TutorialStep } from '../types/tutorial'
import { ElementIndexer } from '../utils/elementIndexer'
import { LLMVerifier } from '../utils/llmVerifier'
import { RouteTracker } from '../utils/routeTracker'
import { findBestElementByInstructionSync } from '../utils/stepElementResolver'
import {
    generateFingerprint,
    saveTutorialRecord,
    loadTutorialRecord,
    findMatchingTutorial,
    markStepCompleted,
    getCompletionHistory,
    type TutorialRecord,
} from '../utils/tutorialMemory'
import { VERSION, PREVIOUS_VERSION } from '../version'

interface Message {
    sender: 'user' | 'bot'
    text: string
}

interface Highlight {
    selector: string
    explanation: string
    elementIndex?: number
    selectionReason?: string
    planStepNumber?: number
}

interface AutomationAction {
    type: string
    url?: string
    selector?: string
}

interface NextStepApiResponse {
    text?: string
    step?: {
        instruction?: string
        actionType?: string
        isTerminal?: boolean
    }
    highlights?: Highlight[]
    sessionId?: string
    reasoning?: string
    done?: boolean
}

const getIndexer = (): ElementIndexer => {
    const win = window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }
    if (!win.__siteTutorElementIndexer) {
        win.__siteTutorElementIndexer = new ElementIndexer()
    }
    return win.__siteTutorElementIndexer
}

const buildViewportInfo = (viewportSummary: string): string => {
    const payload = {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio,
        screenshotWidth: null,
        screenshotHeight: null,
        summary: viewportSummary || '',
    }
    return JSON.stringify(payload)
}

const compressScreenshot = async (dataUrl: string): Promise<Blob | null> => {
    try {
        const response = await fetch(dataUrl)
        const blob = await response.blob()
        return blob
    } catch {
        return null
    }
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

const computeDomSignature = (): string => {
    const indexer = getIndexer()
    indexer.indexPage(document)
    const domText = indexer.toTextRepresentation(true)
    let hash = 0
    const sample = domText.slice(0, 3000)
    for (let i = 0; i < sample.length; i += 1) {
        hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0
    }
    return `${domText.length}:${hash}:${window.location.href}`
}

const STORAGE_KEY_PREFIX = 'siteTutorState'
const FALLBACK_STORAGE_KEY = `${STORAGE_KEY_PREFIX}:default`
const GLOBAL_UI_STATE_KEY = `${STORAGE_KEY_PREFIX}:ui`
const PENDING_NAV_KEY = 'siteTutor:pendingNavigation'
const ADAPTIVE_SCREEN_MODE = true
const ADAPTIVE_STEP_WINDOW = 1
const AUTO_RECALCULATE_ON_PAGE_CHANGE = false
const AUTO_RECALCULATE_ON_DOM_MUTATION = false
const DEFAULT_MESSAGES: Message[] = [
    { sender: 'bot', text: "Hi! I'm your Site Tutor. I can teach you anything about this website. Ask a question or request a tutorial!" }
]

const clearPendingNavigationForTab = (tabId: number | null) => {
    if (!chrome?.storage?.local || tabId === null) return
    chrome.storage.local.get([PENDING_NAV_KEY], (result) => {
        if (chrome.runtime.lastError) return
        const store = (result[PENDING_NAV_KEY] as Record<string, unknown> | undefined) ?? {}
        if (!store[String(tabId)]) return
        delete store[String(tabId)]
        chrome.storage.local.set({ [PENDING_NAV_KEY]: store })
    })
}

const isTutorialIntentMessage = (message: string): boolean => {
    const normalized = message.toLowerCase().trim()
    if (!normalized) return false
    const tutorialIntentPatterns = [
        'tutorial',
        'step by step',
        'step-by-step',
        'walk me through',
        'guide me',
        'show me how',
        'teach me how',
        'how to ',
        'how do i ',
        'help me do',
        'what should i click',
    ]
    return tutorialIntentPatterns.some(pattern => normalized.includes(pattern))
}

const extractNumberedSteps = (text: string): string[] | null => {
    const lines = text.split(/\r?\n/).map(line => line.trim())
    const steps: string[] = []
    let current = ''

    lines.forEach(line => {
        if (!line) return
        const match = line.match(/^\s*\d+(?:\.|\))\s+(.*)$/)
        if (match) {
            if (current.length > 0) {
                steps.push(current.trim())
            }
            current = match[1].trim()
            return
        }

        if (current.length > 0) {
            current += ` ${line}`
        }
    })

    if (current.length > 0) {
        steps.push(current.trim())
    }

    const minSteps = ADAPTIVE_SCREEN_MODE ? 1 : 2
    return steps.length >= minSteps ? steps : null
}

const limitAdaptiveSteps = (steps: string[]): string[] => {
    if (!ADAPTIVE_SCREEN_MODE) return steps
    const windowSize = Math.max(1, ADAPTIVE_STEP_WINDOW)
    return steps.slice(0, windowSize)
}

const inferActionType = (text: string): TutorialActionType => {
    const lower = text.toLowerCase()
    if (lower.includes('type') || lower.includes('enter') || lower.includes('fill')) {
        return 'input'
    }
    if (lower.includes('go to') || lower.includes('navigate') || lower.includes('open')) {
        return 'navigate'
    }
    if (lower.includes('wait for') || lower.includes('observe') || lower.includes('confirm') || lower.includes('you are on')) {
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

const buildTutorialFromSteps = (steps: string[], highlights?: Highlight[]): TutorialPayload => {
    return {
        title: 'Step-by-step guide',
        steps: steps.map((instruction, index) => {
            const actionType = inferActionType(instruction)
            return {
            stepNumber: index + 1,
            selector: highlights?.[index]?.selector ?? '',
            instruction,
            actionType,
            selectionReason: highlights?.[index]?.selectionReason || highlights?.[index]?.explanation,
            isTerminal: index === steps.length - 1,
            elementIndex: highlights?.[index]?.elementIndex
            }
        })
    }
}

const buildHighlightsFromSteps = (steps: TutorialPayload['steps'], highlights?: Highlight[]): Highlight[] => {
    return steps.map((step, index) => ({
        selector: highlights?.[index]?.selector ?? step.selector ?? '',
        explanation: step.instruction,
        elementIndex: highlights?.[index]?.elementIndex ?? step.elementIndex,
        selectionReason: highlights?.[index]?.selectionReason ?? step.selectionReason,
        planStepNumber: highlights?.[index]?.planStepNumber,
    }))
}

const buildAdaptiveTutorialFromNextStep = (
    data: NextStepApiResponse,
    fallbackTitle: string
): { tutorialPayload: TutorialPayload; highlights: Highlight[]; botText: string } | null => {
    const rawInstruction = data?.step?.instruction ?? ''
    const fallbackText = typeof data?.text === 'string' ? data.text.trim() : ''
    const instruction = (rawInstruction || fallbackText).trim()
    if (!instruction) return null

    const actionType = normalizeActionType(data?.step?.actionType, instruction)
    const isTerminal = Boolean(data?.step?.isTerminal)
    const rawHighlights = Array.isArray(data?.highlights) ? data.highlights : []
    const firstHighlight = rawHighlights[0] ?? {}

    let adaptiveSteps: TutorialStep[] = [{
        stepNumber: 1,
        selector: typeof firstHighlight.selector === 'string' ? firstHighlight.selector : '',
        instruction,
        actionType,
        selectionReason: firstHighlight.selectionReason || firstHighlight.explanation || instruction,
        isTerminal,
        elementIndex: typeof firstHighlight.elementIndex === 'number' ? firstHighlight.elementIndex : undefined,
    }]

    adaptiveSteps = fillMissingStepElementIndices(adaptiveSteps)
    const adaptiveHighlights = buildHighlightsFromSteps(adaptiveSteps, rawHighlights.slice(0, 1))
    const tutorialPayload: TutorialPayload = {
        title: fallbackTitle || 'Step-by-step guide',
        steps: adaptiveSteps,
        plan: undefined,
        planStepOffset: 0,
    }

    return {
        tutorialPayload,
        highlights: adaptiveHighlights,
        botText: fallbackText || instruction,
    }
}

type PagePlanStep = TutorialPlan['planSteps'][number]

const normalizePlanHighlights = (rawHighlights: any[]): Highlight[] => {
    if (!Array.isArray(rawHighlights)) return []
    return rawHighlights
        .filter((item) => item && typeof item === 'object')
        .map((h) => ({
            selector: typeof h.selector === 'string' ? h.selector : '',
            explanation: typeof h.explanation === 'string' ? h.explanation : '',
            elementIndex: typeof h.elementIndex === 'number' ? h.elementIndex : undefined,
            selectionReason: typeof h.selectionReason === 'string' ? h.selectionReason : '',
            planStepNumber: typeof h.planStepNumber === 'number' ? h.planStepNumber : undefined,
        }))
}

const alignHighlightsToPlanSteps = (
    currentPagePlanSteps: PagePlanStep[],
    rawHighlights: any[]
): Highlight[] => {
    const normalized = normalizePlanHighlights(rawHighlights)
    if (currentPagePlanSteps.length === 0) return []
    if (normalized.length === 0) {
        return currentPagePlanSteps.map((step) => ({
            selector: '',
            explanation: '',
            elementIndex: undefined,
            selectionReason: '',
            planStepNumber: step.stepNumber,
        }))
    }

    const stepNumbers = new Set(currentPagePlanSteps.map((step) => step.stepNumber))
    const byStepNumber = new Map<number, Highlight>()
    const sequential: Highlight[] = []

    for (const highlight of normalized) {
        const stepNumber = highlight.planStepNumber
        if (typeof stepNumber === 'number' && stepNumbers.has(stepNumber) && !byStepNumber.has(stepNumber)) {
            byStepNumber.set(stepNumber, highlight)
            continue
        }
        sequential.push(highlight)
    }

    let sequentialCursor = 0
    return currentPagePlanSteps.map((step) => {
        const explicit = byStepNumber.get(step.stepNumber)
        if (explicit) {
            return {
                ...explicit,
                planStepNumber: step.stepNumber,
            }
        }
        const fallback = sequential[sequentialCursor]
        if (fallback) {
            sequentialCursor += 1
            return {
                ...fallback,
                planStepNumber: step.stepNumber,
            }
        }
        return {
            selector: '',
            explanation: '',
            elementIndex: undefined,
            selectionReason: '',
            planStepNumber: step.stepNumber,
        }
    })
}

const fillMissingStepElementIndices = (steps: TutorialStep[]): TutorialStep[] => {
    if (!steps.some((step) => step.elementIndex == null && step.actionType !== 'observe' && step.actionType !== 'wait')) {
        return steps
    }

    const indexer = getIndexer()
    try {
        indexer.indexPage(document)
    } catch {
        return steps
    }

    const indexedElements = indexer.getAllElements()
    if (!indexedElements.length) return steps

    const elementToIndex = new Map<HTMLElement, number>()
    for (const entry of indexedElements) {
        elementToIndex.set(entry.element, entry.index)
    }

    const getIndexForElement = (el: Element | null): number | undefined => {
        if (!(el instanceof HTMLElement)) return undefined
        return elementToIndex.get(el)
    }

    let filledCount = 0
    let unresolvedCount = 0

    const hydrated = steps.map((step) => {
        if (step.elementIndex != null) return step
        if (step.actionType === 'observe' || step.actionType === 'wait') return step

        let resolvedIndex: number | undefined

        if (step.selector) {
            try {
                resolvedIndex = getIndexForElement(document.querySelector(step.selector))
            } catch {
                resolvedIndex = undefined
            }
        }

        if (resolvedIndex == null) {
            const resolvedElement = findBestElementByInstructionSync(step.instruction)
            resolvedIndex = getIndexForElement(resolvedElement)
        }

        if (resolvedIndex == null) {
            unresolvedCount += 1
            return step
        }
        filledCount += 1

        return {
            ...step,
            elementIndex: resolvedIndex,
            selectionReason: step.selectionReason || 'Resolved from current page DOM fallback.',
        }
    })

    if (filledCount > 0 || unresolvedCount > 0) {
        console.log(`[Site Tutor] Step target hydration | filled=${filledCount} unresolved=${unresolvedCount}`)
    }

    return hydrated
}

const normalizeText = (value: string): string =>
    value.toLowerCase().replace(/\s+/g, ' ').trim()

const extractSignals = (step: TutorialStep): string[] => {
    const signals = new Set<string>()
    const quotedInstruction = step.instruction.match(/"([^"]+)"/g) ?? []
    quotedInstruction.forEach((part) => {
        const cleaned = part.replace(/"/g, '').trim()
        if (cleaned) signals.add(cleaned)
    })

    return Array.from(signals)
}

const isStepAlreadySatisfied = (step: TutorialStep): boolean => {
    const url = normalizeText(window.location.href)
    const title = normalizeText(document.title || '')
    const bodyText = normalizeText(document.body?.textContent || '')
    const signals = extractSignals(step).map(normalizeText).filter(signal => signal.length >= 3)

    if (step.actionType === 'input') {
        const selector = step.selector
        if (selector) {
            try {
                const input = document.querySelector(selector)
                if (
                    input instanceof HTMLInputElement ||
                    input instanceof HTMLTextAreaElement
                ) {
                    return input.value.trim().length > 0
                }
            } catch {
                // ignore invalid selector
            }
        }
        return false
    }

    const hasSignalMatch = signals.some(signal =>
        url.includes(signal) || title.includes(signal) || bodyText.includes(signal)
    )

    if (hasSignalMatch) return true

    if (step.actionType === 'observe' || step.actionType === 'wait') {
        return signals.length === 0 ? true : hasSignalMatch
    }

    return false
}

const findFirstActionableStep = (steps: TutorialStep[]): number => {
    if (!steps.length) return 0
    const next = steps.findIndex(step => !isStepAlreadySatisfied(step))
    if (next >= 0) return next
    return Math.max(steps.length - 1, 0)
}

const SESSION_STORE_KEY = `${STORAGE_KEY_PREFIX}:sessions`


const escapeHtml = (text: string): string =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

const applyInlineMarkdown = (text: string): string => {
    let output = text
    output = output.replace(/`([^`]+)`/g, '<code>$1</code>')
    output = output.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong>$1</strong>')
    output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    output = output.replace(/__([^_]+)__/g, '<strong>$1</strong>')
    output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    output = output.replace(/_([^_]+)_/g, '<em>$1</em>')
    return output
}

const renderMarkdown = (raw: string): string => {
    const lines = escapeHtml(raw).split(/\r?\n/)
    let html = ''
    let paragraph: string[] = []
    let listType: 'ol' | 'ul' | null = null
    let listItems: string[] = []

    const flushParagraph = () => {
        if (paragraph.length === 0) return
        const content = paragraph.join('<br />')
        html += `<p>${applyInlineMarkdown(content)}</p>`
        paragraph = []
    }

    const flushList = () => {
        if (!listType || listItems.length === 0) return
        const itemsHtml = listItems.map(item => `<li>${applyInlineMarkdown(item)}</li>`).join('')
        html += `<${listType}>${itemsHtml}</${listType}>`
        listType = null
        listItems = []
    }

    lines.forEach(line => {
        const trimmed = line.trim()
        if (!trimmed) {
            flushParagraph()
            flushList()
            return
        }

        const orderedMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/)
        if (orderedMatch) {
            flushParagraph()
            if (listType && listType !== 'ol') {
                flushList()
            }
            listType = 'ol'
            listItems.push(orderedMatch[2])
            return
        }

        const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/)
        if (unorderedMatch) {
            flushParagraph()
            if (listType && listType !== 'ul') {
                flushList()
            }
            listType = 'ul'
            listItems.push(unorderedMatch[1])
            return
        }

        if (listType) {
            flushList()
        }
        paragraph.push(trimmed)
    })

    flushParagraph()
    flushList()

    return html
}

interface StoredState {
    tutorial: TutorialPayload | null
    currentTutorialStep: number
    isOpen: boolean
    origin?: string
    lastUrl?: string
    sessionId?: string | null
}

interface SessionSnapshot {
    tutorial: TutorialPayload | null
    currentTutorialStep: number
    isOpen: boolean
    origin: string
    lastUrl: string
    updatedAt: number
    sessionId?: string | null
}

type SessionStore = Record<string, SessionSnapshot>

type ChatMode = 'tutorial' | 'idle'

const isReloadNavigation = (): boolean => {
    try {
        const navEntries = performance.getEntriesByType('navigation')
        const first = navEntries[0] as PerformanceNavigationTiming | undefined
        if (first?.type) {
            return first.type === 'reload'
        }
    } catch {
        // Ignore and fall back to legacy API.
    }

    const legacyNav = (performance as Performance & { navigation?: { type?: number } }).navigation
    return legacyNav?.type === 1
}

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [mode, setMode] = useState<ChatMode>('idle')
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [showVersionInfo, setShowVersionInfo] = useState(false)

    // Chat state
    const [messages, setMessages] = useState<Message[]>(DEFAULT_MESSAGES)
    const [highlights, setHighlights] = useState<Highlight[]>([])
    const [sessionId, setSessionId] = useState<string | null>(null)

    // Tutorial mode state
    const [tutorial, setTutorial] = useState<TutorialPayload | null>(null)
    const [currentTutorialStep, setCurrentTutorialStep] = useState(0)
    const [isRestoring, setIsRestoring] = useState(true)
    const [storageKey, setStorageKey] = useState<string | null>(null)
    const [tabId, setTabId] = useState<number | null>(null)
    const [tutorialFingerprint, setTutorialFingerprint] = useState<string | null>(null)
    const [restoredLastUrl, setRestoredLastUrl] = useState<string | null>(null)

    // LLM verification state
    const llmVerifierRef = useRef<LLMVerifier | null>(null)
    const routeTrackerRef = useRef<RouteTracker | null>(null)
    const dynamicRecalcInFlightRef = useRef(false)
    const lastDynamicRecalcKeyRef = useRef('')
    const lastDomSignatureRef = useRef('')
    const lastDomRecalcAtRef = useRef(0)
    const storedLinkRef = useRef(window.location.href)
    const didLinkChangeRef = useRef(false)
    const activeTutorialGoalRef = useRef('')

    const messagesEndRef = useRef<HTMLDivElement>(null)
    const totalTutorialSteps = tutorial?.steps.length ?? 0
    const currentStepNumber = Math.min(currentTutorialStep + 1, Math.max(totalTutorialSteps, 1))

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

    // Initialize storage key for tutorial persistence
    useEffect(() => {
        chrome.runtime.sendMessage({ action: 'getTabId' }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('Site Tutor: unable to determine tab id', chrome.runtime.lastError)
                setStorageKey(FALLBACK_STORAGE_KEY)
                return
            }

            const key = `${STORAGE_KEY_PREFIX}:${response?.tabId ?? 'default'}`
            setTabId(typeof response?.tabId === 'number' ? response.tabId : null)
            ;(window as typeof window & { __siteTutorTabId?: number | null }).__siteTutorTabId =
                typeof response?.tabId === 'number' ? response.tabId : null
            setStorageKey(key)
        })
    }, [])

    // Load API key and initialize verifiers
    useEffect(() => {
        chrome.storage.local.get('openai_api_key', (result) => {
            const rawApiKey = (result as Record<string, unknown>).openai_api_key
            const apiKey = typeof rawApiKey === 'string' ? rawApiKey : ''

            if (apiKey) {
                llmVerifierRef.current = new LLMVerifier(apiKey)
            } else {
                llmVerifierRef.current = null
            }
        })
    }, [])

    // Initialize route tracker when tutorial starts
    useEffect(() => {
        if (tutorialFingerprint && !routeTrackerRef.current) {
            routeTrackerRef.current = new RouteTracker(tutorialFingerprint)
        } else if (!tutorialFingerprint && routeTrackerRef.current) {
            routeTrackerRef.current = null
        }
    }, [tutorialFingerprint])

    const recalculateTutorialForCurrentPage = useCallback(async (reason: string = 'page-changed', dedupeKey?: string): Promise<boolean> => {
        if (mode !== 'tutorial' || !tutorial) return false

        const currentUrl = window.location.href
        const recalcKey = `${currentUrl}::${dedupeKey || reason}`
        if (dynamicRecalcInFlightRef.current) return false
        if (lastDynamicRecalcKeyRef.current === recalcKey) return false

        console.log(`🔄 [Site Tutor] Dynamic recalculation start | reason=${reason} | url=${currentUrl}`)
        dynamicRecalcInFlightRef.current = true
        lastDynamicRecalcKeyRef.current = recalcKey

        try {
            const formData = new FormData()
            const globalStepIndex = (tutorial.planStepOffset ?? 0) + currentTutorialStep
            const canUseContinueEndpoint = Boolean(tutorial.plan && sessionId)

            if (sessionId) {
                formData.append('sessionId', sessionId)
            }

            const tutorialContext = {
                title: tutorial.title,
                currentStepIndex: currentTutorialStep,
                currentGlobalStepIndex: globalStepIndex,
                totalSteps: tutorial.steps.length,
                currentStep: tutorial.steps[currentTutorialStep]?.instruction ?? '',
                currentActionType: tutorial.steps[currentTutorialStep]?.actionType ?? 'click',
                steps: tutorial.steps.map(step => step.instruction),
                recalculationReason: reason,
                currentUrl,
            }

            const indexer = getIndexer()
            indexer.indexPage(document)
            const domText = indexer.toTextRepresentation(true)
            const viewportSummary = indexer.getViewportSummary()
            const viewportInfo = buildViewportInfo(viewportSummary)
            formData.append('dom', domText)
            formData.append('viewportInfo', viewportInfo)
            formData.append('viewportWidth', String(window.innerWidth))
            formData.append('viewportHeight', String(window.innerHeight))
            formData.append('scrollPosition', String(window.scrollY))

            if (ADAPTIVE_SCREEN_MODE) {
                const adaptiveGoal = activeTutorialGoalRef.current.trim()
                    || tutorial.title.trim()
                    || tutorial.steps[0]?.instruction?.trim()
                if (!adaptiveGoal) return false
                activeTutorialGoalRef.current = adaptiveGoal

                formData.append('goal', adaptiveGoal)
                formData.append('currentUrl', currentUrl)
                formData.append('tutorialContext', JSON.stringify(tutorialContext))
                const completedInstruction = tutorial.steps[currentTutorialStep]?.instruction ?? ''
                if (completedInstruction) {
                    formData.append('completedStepInstruction', completedInstruction)
                }

                try {
                    const screenshotBlob = await captureScreenshot()
                    if (screenshotBlob) {
                        formData.append('screenshot', screenshotBlob, 'screenshot.png')
                    }
                } catch (screenshotError) {
                    console.warn('📸 [Site Tutor] Screenshot capture failed for /next-step recalculation', screenshotError)
                }

                console.log(`🧠 [Site Tutor] DOM forwarded to /next-step (dynamic) | chars=${domText.length} | url=${currentUrl}`)
                console.log('📡 [Site Tutor] POST /next-step (dynamic recalculation)')
                const response = await fetch('http://localhost:8000/next-step', {
                    method: 'POST',
                    body: formData,
                })
                if (!response.ok) {
                    const errorText = await response.text().catch(() => '')
                    throw new Error(`Adaptive recalculation failed: ${response.status} ${errorText}`)
                }
                const data: NextStepApiResponse = await response.json()
                if (data.sessionId && !sessionId) {
                    setSessionId(data.sessionId)
                }
                const adaptive = buildAdaptiveTutorialFromNextStep(data, tutorial.title || 'Step-by-step guide')
                if (!adaptive) {
                    if (data.done) return false
                    throw new Error('No adaptive next step returned')
                }

                setMode('tutorial')
                setTutorial(adaptive.tutorialPayload)
                setCurrentTutorialStep(findFirstActionableStep(adaptive.tutorialPayload.steps))
                setHighlights(adaptive.highlights)
                console.log('✅ [Site Tutor] Dynamic adaptive recalculation applied | newSteps=1')
                return true
            }

            if (!canUseContinueEndpoint) {
                formData.append(
                    'message',
                    'Continue the active tutorial on this current page. Recalculate the next actionable steps for this page and return accurate highlights.'
                )
                formData.append('tutorialContext', JSON.stringify(tutorialContext))
            }

            console.log(`🧠 [Site Tutor] DOM forwarded to /chat (dynamic) | chars=${domText.length} | url=${currentUrl}`)

            let data: any
            if (canUseContinueEndpoint && tutorial.plan) {
                const completedIndices = Array.from({ length: Math.max(0, globalStepIndex) }, (_, i) => i)
                formData.append('currentPlanStepIndex', String(globalStepIndex))
                formData.append('completedSteps', JSON.stringify(completedIndices))
                formData.append('currentUrl', currentUrl)
                formData.append('completedStepInstruction', tutorial.steps[Math.max(0, currentTutorialStep - 1)]?.instruction ?? '')

                console.log('📡 [Site Tutor] POST /continue-tutorial (dynamic recalculation with VLM)')
                const response = await fetch('http://localhost:8000/continue-tutorial', {
                    method: 'POST',
                    body: formData,
                })
                if (!response.ok) {
                    const errorText = await response.text().catch(() => '')
                    console.warn(`❌ [Site Tutor] /continue-tutorial error ${response.status}: ${errorText}`)
                    throw new Error(`Continue recalculation failed: ${response.status} ${errorText}`)
                }
                data = await response.json()
            } else {
                console.log('📡 [Site Tutor] POST /chat (dynamic recalculation)')
                const response = await fetch('http://localhost:8000/chat', {
                    method: 'POST',
                    body: formData,
                })
                if (!response.ok) {
                    throw new Error(`Recalculation failed: ${response.status}`)
                }
                data = await response.json()
            }
            if (data.sessionId && !sessionId) {
                setSessionId(data.sessionId)
            }

            const planData = canUseContinueEndpoint && tutorial.plan
                ? {
                    ...tutorial.plan,
                    currentPageHighlights: data.currentPageHighlights ?? [],
                    currentPageRange: data.currentPageRange ?? { startIndex: globalStepIndex, endIndex: globalStepIndex },
                } as TutorialPlan
                : (data.tutorialPlan as TutorialPlan | undefined)
            if (planData && planData.planSteps && planData.planSteps.length > 0) {
                const currentRange = planData.currentPageRange ?? { startIndex: 0, endIndex: 0 }
                const currentPagePlanSteps = planData.planSteps.slice(
                    currentRange.startIndex,
                    currentRange.endIndex + 1
                )
                const currentPageHighlights = planData.currentPageHighlights ?? data.highlights ?? []
                const alignedHighlights = alignHighlightsToPlanSteps(currentPagePlanSteps, currentPageHighlights)

                let currentPageTutorialSteps: TutorialStep[] = currentPagePlanSteps.map((ps, idx) => ({
                    stepNumber: ps.stepNumber,
                    selector: alignedHighlights[idx]?.selector ?? '',
                    instruction: ps.instruction,
                    actionType: normalizeActionType(ps.actionType, ps.instruction),
                    selectionReason: alignedHighlights[idx]?.selectionReason || alignedHighlights[idx]?.explanation,
                    isTerminal: Boolean(ps.isTerminal),
                    elementIndex: alignedHighlights[idx]?.elementIndex,
                }))
                currentPageTutorialSteps = fillMissingStepElementIndices(currentPageTutorialSteps)

                const windowedSteps = ADAPTIVE_SCREEN_MODE
                    ? currentPageTutorialSteps.slice(0, Math.max(1, ADAPTIVE_STEP_WINDOW))
                    : currentPageTutorialSteps
                const windowedHighlights = ADAPTIVE_SCREEN_MODE
                    ? alignedHighlights.slice(0, windowedSteps.length)
                    : alignedHighlights

                const tutorialPayload: TutorialPayload = {
                    title: planData.title || tutorial.title || 'Step-by-step guide',
                    steps: windowedSteps,
                    plan: ADAPTIVE_SCREEN_MODE ? undefined : planData,
                    planStepOffset: ADAPTIVE_SCREEN_MODE ? 0 : currentRange.startIndex,
                }

                setMode('tutorial')
                setTutorial(tutorialPayload)
                setCurrentTutorialStep(findFirstActionableStep(windowedSteps))
                setHighlights(buildHighlightsFromSteps(windowedSteps, windowedHighlights))
                console.log(`✅ [Site Tutor] Dynamic recalculation applied | newSteps=${windowedSteps.length}`)
                return true
            }

            const parsedSteps = extractNumberedSteps(data.text || '')
            if (parsedSteps && parsedSteps.length > 0) {
                const adaptiveSteps = limitAdaptiveSteps(parsedSteps)
                const adaptiveHighlights = Array.isArray(data.highlights)
                    ? data.highlights.slice(0, adaptiveSteps.length)
                    : data.highlights
                const tutorialPayload = buildTutorialFromSteps(adaptiveSteps, adaptiveHighlights)
                setMode('tutorial')
                setTutorial(tutorialPayload)
                setCurrentTutorialStep(findFirstActionableStep(tutorialPayload.steps))
                setHighlights(buildHighlightsFromSteps(tutorialPayload.steps, adaptiveHighlights))
                console.log(`✅ [Site Tutor] Dynamic recalculation applied from text steps | newSteps=${adaptiveSteps.length}`)
                return true
            }
        } catch (error) {
            console.warn('❌ [Site Tutor] Dynamic tutorial recalculation failed', error)
            // Allow retry on next page-change signal if this attempt failed.
            lastDynamicRecalcKeyRef.current = ''
            return true
        } finally {
            console.log('🏁 [Site Tutor] Dynamic recalculation finished')
            dynamicRecalcInFlightRef.current = false
        }
        return false
    }, [mode, tutorial, sessionId, currentTutorialStep])

    // Re-index DOM on page change. Do not auto-recalculate steps unless explicitly enabled.
    useEffect(() => {
        const handlePageChanged = (event: Event) => {
            const custom = event as CustomEvent<{ currentUrl?: string; previousUrl?: string; reason?: string }>
            const currentUrl = custom?.detail?.currentUrl || window.location.href
            const previousUrl = custom?.detail?.previousUrl || storedLinkRef.current
            const linkChanged = previousUrl !== currentUrl
            const triggerReason = (custom?.detail?.reason || 'page-changed').toLowerCase()

            didLinkChangeRef.current = linkChanged
            storedLinkRef.current = currentUrl

            console.log(`🧭 [Site Tutor] siteTutor:pageChanged | url=${currentUrl} | changed=${linkChanged} | reason=${triggerReason}`)
            console.log('🧠 [Site Tutor] Re-indexing DOM due to page change')
            const indexer = getIndexer()
            indexer.indexPage(document)

            // If in tutorial mode, refresh the highlights from the current tutorial steps
            if (tutorial && mode === 'tutorial') {
                // On real navigation, clear selected DOM targets so stale indices are never carried across pages.
                if (linkChanged) {
                    setHighlights([])
                    setTutorial(prev => prev ? {
                        ...prev,
                        steps: prev.steps.map(step => ({
                            ...step,
                            elementIndex: undefined,
                            selector: '',
                        })),
                    } : null)
                    console.log('🧼 [Site Tutor] URL changed during tutorial -> cleared selected DOM targets')
                    if (AUTO_RECALCULATE_ON_PAGE_CHANGE) {
                        void recalculateTutorialForCurrentPage(
                            'page-changed-fallback',
                            `url:${currentUrl}:changed:${String(linkChanged)}`
                        )
                    }
                }
            }
        }

        window.addEventListener('siteTutor:pageChanged', handlePageChanged)
        return () => {
            window.removeEventListener('siteTutor:pageChanged', handlePageChanged)
        }
    }, [tutorial, mode, recalculateTutorialForCurrentPage])

    // Optional auto-recalculation path for same-URL DOM mutations.
    useEffect(() => {
        if (!AUTO_RECALCULATE_ON_DOM_MUTATION) return
        if (mode !== 'tutorial' || !tutorial) return
        // Plan/session flow already has dedicated page-transition handling in TutorialController.
        if (tutorial.plan && sessionId) return

        let debounceTimer: number | null = null
        const mutationObserver = new MutationObserver(() => {
            if (debounceTimer !== null) {
                window.clearTimeout(debounceTimer)
            }

            debounceTimer = window.setTimeout(() => {
                try {
                    const activeEl = document.activeElement as HTMLElement | null
                    if (
                        activeEl &&
                        (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)
                    ) {
                        return
                    }
                    const signature = computeDomSignature()
                    if (!lastDomSignatureRef.current) {
                        lastDomSignatureRef.current = signature
                        return
                    }
                    if (signature === lastDomSignatureRef.current) {
                        return
                    }
                    const now = Date.now()
                    if (now - lastDomRecalcAtRef.current < 3000) {
                        lastDomSignatureRef.current = signature
                        return
                    }

                    lastDomSignatureRef.current = signature
                    lastDomRecalcAtRef.current = now
                    console.log(`🧩 [Site Tutor] DOM changed -> triggering fresh instruction recalculation`)
                    void recalculateTutorialForCurrentPage('dom-changed', `dom:${signature}`)
                } catch (error) {
                    console.warn('⚠️ [Site Tutor] DOM signature compute failed', error)
                }
            }, 900)
        })

        if (document.body) {
            mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            })
            try {
                lastDomSignatureRef.current = computeDomSignature()
            } catch {
                lastDomSignatureRef.current = ''
            }
        }

        return () => {
            mutationObserver.disconnect()
            if (debounceTimer !== null) window.clearTimeout(debounceTimer)
        }
    }, [mode, tutorial, recalculateTutorialForCurrentPage])

    useEffect(() => {
        if (mode !== 'tutorial' || !tutorial) {
            dynamicRecalcInFlightRef.current = false
            lastDynamicRecalcKeyRef.current = ''
            lastDomSignatureRef.current = ''
            lastDomRecalcAtRef.current = 0
            didLinkChangeRef.current = false
            storedLinkRef.current = window.location.href
        }
    }, [mode, tutorial])

    // Restore tutorial state from storage
    useEffect(() => {
        if (!storageKey) return
        setRestoredLastUrl(null)

        // Check if chrome.storage is available
        if (!chrome?.storage?.local) {
            console.warn('Site Tutor: chrome.storage not available')
            setIsRestoring(false)
            return
        }

        chrome.storage.local.get([storageKey, SESSION_STORE_KEY, GLOBAL_UI_STATE_KEY], (result) => {
            if (chrome.runtime.lastError) {
                console.warn('Failed to load state:', chrome.runtime.lastError)
                setIsRestoring(false)
                return
            }

            const stored = result[storageKey] as StoredState | undefined
            const sessionStore = result[SESSION_STORE_KEY] as SessionStore | undefined
            const uiState = result[GLOBAL_UI_STATE_KEY] as { isOpen?: boolean } | undefined
            const globalIsOpen = uiState?.isOpen === true
            const session = tabId !== null ? sessionStore?.[String(tabId)] : undefined

            const restoredUrl = stored?.lastUrl ?? session?.lastUrl ?? null
            if (isReloadNavigation()) {
                const openState = stored?.isOpen ?? session?.isOpen ?? globalIsOpen
                activeTutorialGoalRef.current = ''
                setIsOpen(!!openState)
                setTutorial(null)
                setCurrentTutorialStep(0)
                setMode('idle')
                setHighlights([])
                setSessionId(null)
                setRestoredLastUrl(window.location.href)
                setMessages(DEFAULT_MESSAGES)
                setInput('')
                setLoading(false)

                const clearedState: StoredState = {
                    tutorial: null,
                    currentTutorialStep: 0,
                    isOpen: !!openState,
                    origin: window.location.origin,
                    lastUrl: window.location.href,
                    sessionId: null,
                }
                chrome.storage.local.set({ [storageKey]: clearedState })
                if (tabId !== null) {
                    const store = sessionStore ?? {}
                    store[String(tabId)] = {
                        tutorial: null,
                        currentTutorialStep: 0,
                        isOpen: !!openState,
                        origin: window.location.origin,
                        lastUrl: window.location.href,
                        updatedAt: Date.now(),
                        sessionId: null,
                    }
                    chrome.storage.local.set({ [SESSION_STORE_KEY]: store })
                }

                setIsRestoring(false)
                return
            }

            if (stored && stored.origin === window.location.origin) {
                setTutorial(stored.tutorial)
                setCurrentTutorialStep(stored.currentTutorialStep)
                setIsOpen(stored.isOpen || globalIsOpen)
                setRestoredLastUrl(restoredUrl)
                setSessionId(stored.sessionId ?? null)
                if (stored.tutorial) {
                    activeTutorialGoalRef.current = stored.tutorial.title || ''
                    setMode('tutorial')
                    setHighlights(buildHighlightsFromSteps(stored.tutorial.steps))
                } else {
                    activeTutorialGoalRef.current = ''
                    setHighlights([])
                }
            } else if (session && session.origin === window.location.origin) {
                const hasTutorial = !!session.tutorial
                const didAdvanceForUrlChange = session.lastUrl !== window.location.href && hasTutorial
                const nextStepIndex = didAdvanceForUrlChange && session.tutorial
                    ? Math.min(session.currentTutorialStep + 1, session.tutorial.steps.length - 1)
                    : session.currentTutorialStep

                setTutorial(session.tutorial)
                setCurrentTutorialStep(nextStepIndex)
                setIsOpen(session.isOpen || globalIsOpen)
                setRestoredLastUrl(restoredUrl)
                setSessionId(session.sessionId ?? null)
                if (session.tutorial) {
                    activeTutorialGoalRef.current = session.tutorial.title || ''
                    setMode('tutorial')
                    setHighlights(buildHighlightsFromSteps(session.tutorial.steps))
                } else {
                    activeTutorialGoalRef.current = ''
                    setHighlights([])
                }
                if (didAdvanceForUrlChange) {
                    clearPendingNavigationForTab(tabId)
                }
            } else {
                const openState = stored?.isOpen ?? session?.isOpen ?? globalIsOpen
                activeTutorialGoalRef.current = ''
                setIsOpen(!!openState)
                setTutorial(null)
                setCurrentTutorialStep(0)
                setMode('idle')
                setHighlights([])
                setSessionId(null)
                setRestoredLastUrl(restoredUrl)
                setMessages(DEFAULT_MESSAGES)
            }

            setIsRestoring(false)
        })
    }, [storageKey, tabId])

    // Persist tutorial state to storage
    useEffect(() => {
        if (!storageKey || isRestoring) return
        if (!chrome?.storage?.local) return

        const state: StoredState = {
            tutorial,
            currentTutorialStep,
            isOpen,
            origin: window.location.origin,
            lastUrl: window.location.href,
            sessionId,
        }

        chrome.storage.local.set({ [storageKey]: state })
    }, [tutorial, currentTutorialStep, isOpen, storageKey, isRestoring])

    useEffect(() => {
        if (isRestoring) return
        if (!chrome?.storage?.local) return

        chrome.storage.local.set({ [GLOBAL_UI_STATE_KEY]: { isOpen } })
    }, [isOpen, isRestoring])

    useEffect(() => {
        if (tabId === null || isRestoring) return
        if (!chrome?.storage?.local) return

        const snapshot: SessionSnapshot = {
            tutorial,
            currentTutorialStep,
            isOpen,
            origin: window.location.origin,
            lastUrl: window.location.href,
            updatedAt: Date.now(),
            sessionId,
        }

        chrome.storage.local.get([SESSION_STORE_KEY], (result) => {
            if (chrome.runtime.lastError) {
                console.warn('Failed to load session store:', chrome.runtime.lastError)
                return
            }

            const store = (result[SESSION_STORE_KEY] as SessionStore | undefined) ?? {}
            store[String(tabId)] = snapshot
            chrome.storage.local.set({ [SESSION_STORE_KEY]: store })
        })
    }, [tutorial, currentTutorialStep, isOpen, tabId, isRestoring])

    const exitTutorial = () => {
        activeTutorialGoalRef.current = ''
        setTutorial(null)
        setCurrentTutorialStep(0)
        setMode('idle')
        setRestoredLastUrl(null)
    }

    const handleTutorialComplete = () => {
        if (tutorialFingerprint) {
            // Mark all steps completed
            const stepCount = tutorial?.steps.length ?? 0
            for (let i = 0; i < stepCount; i++) {
                markStepCompleted(tutorialFingerprint, i).catch(() => {})
            }
        }
        activeTutorialGoalRef.current = ''
        setTutorialFingerprint(null)
        exitTutorial()
        setHighlights([])
    }

    const handleReset = () => {
        activeTutorialGoalRef.current = ''
        exitTutorial()
        setHighlights([])
        setInput('')
        setLoading(false)
        setSessionId(null)
        setMessages(DEFAULT_MESSAGES)
    }

    const handleSend = async () => {
        if (!input.trim()) return

        const userMessage = input
        const useAdaptiveNextStep = ADAPTIVE_SCREEN_MODE && isTutorialIntentMessage(userMessage)
        console.log(`💬 [Site Tutor] User message -> ${useAdaptiveNextStep ? '/next-step' : '/chat'} | url=${window.location.href} | text="${userMessage}"`)
        setInput('')
        setLoading(true)
        setHighlights([])

        setMode('idle')
        setMessages(prev => [...prev, { sender: 'user', text: userMessage }])

        try {
            // Prepare Form Data
            const formData = new FormData()
            if (useAdaptiveNextStep) {
                formData.append('goal', userMessage)
                formData.append('currentUrl', window.location.href)
            } else {
                formData.append('message', userMessage)
            }

            // Include session ID if we have one
            if (sessionId) {
                formData.append('sessionId', sessionId)
            }

            if (tutorial && mode === 'tutorial') {
                const globalStepIndex = (tutorial.planStepOffset ?? 0) + currentTutorialStep
                const tutorialContext = {
                    title: tutorial.title,
                    currentStepIndex: currentTutorialStep,
                    currentGlobalStepIndex: globalStepIndex,
                    totalSteps: tutorial.steps.length,
                    currentStep: tutorial.steps[currentTutorialStep]?.instruction ?? '',
                    currentActionType: tutorial.steps[currentTutorialStep]?.actionType ?? 'click',
                    steps: tutorial.steps.map(step => step.instruction),
                }
                formData.append('tutorialContext', JSON.stringify(tutorialContext))
            }

            // Capture screenshot for VLM-enhanced initial tutorial generation
            try {
                const screenshotBlob = await captureScreenshot()
                if (screenshotBlob) {
                    formData.append('screenshot', screenshotBlob, 'screenshot.png')
                    console.log(`📸 [Site Tutor] Screenshot captured for ${useAdaptiveNextStep ? '/next-step' : '/chat'} VLM analysis`)
                } else {
                    console.warn(`📸 [Site Tutor] Screenshot capture failed for ${useAdaptiveNextStep ? '/next-step' : '/chat'}, proceeding without VLM`)
                }
            } catch (screenshotError) {
                console.warn(`📸 [Site Tutor] Screenshot error on ${useAdaptiveNextStep ? '/next-step' : '/chat'}:`, screenshotError)
            }

            // Add indexed DOM context with viewport information
            try {
                const indexer = getIndexer()
                indexer.indexPage(document)
                const domText = indexer.toTextRepresentation(true)  // Include viewport annotations
                const viewportSummary = indexer.getViewportSummary()
                const viewportInfo = buildViewportInfo(viewportSummary)
                formData.append('dom', domText)
                formData.append('viewportInfo', viewportInfo)
                formData.append('viewportWidth', String(window.innerWidth))
                formData.append('viewportHeight', String(window.innerHeight))
                formData.append('scrollPosition', String(window.scrollY))
                console.log(`🧠 [Site Tutor] DOM forwarded to ${useAdaptiveNextStep ? '/next-step' : '/chat'} | chars=${domText.length} | scrollY=${window.scrollY}`)
            } catch (err) {
                console.warn('⚠️ [Site Tutor] Unable to generate indexed DOM', err)
            }

            // Add completion history for /chat tutorials
            if (!useAdaptiveNextStep) {
                try {
                    const history = await getCompletionHistory(window.location.origin)
                    if (history.length > 0) {
                        const summary = history.map(h => `- ${h.title}`).join('\n')
                        formData.append('completionHistory', summary)
                    }
                } catch (err) {
                    console.warn('Site Tutor: unable to load completion history', err)
                }
            }

            // Call Backend
            const endpoint = useAdaptiveNextStep ? 'http://localhost:8000/next-step' : 'http://localhost:8000/chat'
            console.log(`📡 [Site Tutor] POST ${useAdaptiveNextStep ? '/next-step' : '/chat'}`)
            const response = await fetch(endpoint, {
                method: 'POST',
                body: formData
            })

            const data = await response.json()

            // Store session ID from response
            if (data.sessionId && !sessionId) {
                setSessionId(data.sessionId)
                console.log('Session ID received:', data.sessionId)
            }

            if (useAdaptiveNextStep) {
                activeTutorialGoalRef.current = userMessage
                setTutorialFingerprint(null)

                const adaptive = buildAdaptiveTutorialFromNextStep(
                    data as NextStepApiResponse,
                    'Step-by-step guide'
                )
                if (adaptive) {
                    setMode('tutorial')
                    setRestoredLastUrl(null)
                    setTutorial(adaptive.tutorialPayload)
                    setCurrentTutorialStep(findFirstActionableStep(adaptive.tutorialPayload.steps))
                    setHighlights(adaptive.highlights)
                    setMessages(prev => [...prev, {
                        sender: 'bot',
                        text: adaptive.botText || 'Starting adaptive tutorial for this screen.',
                    }])
                } else {
                    setMode('idle')
                    setMessages(prev => [...prev, { sender: 'bot', text: data.text || 'I could not determine the next step on this screen.' }])
                    setHighlights(Array.isArray(data.highlights) ? data.highlights : [])
                }
                return
            }

            // Check if the response includes a tutorial plan (two-tier response)
            const planData = data.tutorialPlan as TutorialPlan | undefined

            const hasTutorialPlan = !ADAPTIVE_SCREEN_MODE && !!(planData && planData.planSteps && planData.planSteps.length > 0)
            if (hasTutorialPlan) {
                // Two-tier plan response: build tutorial from current-page steps only
                const currentRange = planData.currentPageRange ?? { startIndex: 0, endIndex: 0 }
                const currentPagePlanSteps = planData.planSteps.slice(
                    currentRange.startIndex,
                    currentRange.endIndex + 1
                )
                const currentPageHighlights = planData.currentPageHighlights ?? data.highlights ?? []

                const alignedHighlights = alignHighlightsToPlanSteps(currentPagePlanSteps, currentPageHighlights)
                let currentPageTutorialSteps: TutorialStep[] = currentPagePlanSteps.map((ps, idx) => ({
                    stepNumber: ps.stepNumber,
                    selector: alignedHighlights[idx]?.selector ?? '',
                    instruction: ps.instruction,
                    actionType: normalizeActionType(ps.actionType, ps.instruction),
                    selectionReason: alignedHighlights[idx]?.selectionReason || alignedHighlights[idx]?.explanation,
                    isTerminal: Boolean(ps.isTerminal),
                    elementIndex: alignedHighlights[idx]?.elementIndex,
                }))
                currentPageTutorialSteps = fillMissingStepElementIndices(currentPageTutorialSteps)

                const windowedSteps = ADAPTIVE_SCREEN_MODE
                    ? currentPageTutorialSteps.slice(0, Math.max(1, ADAPTIVE_STEP_WINDOW))
                    : currentPageTutorialSteps
                const windowedHighlights = ADAPTIVE_SCREEN_MODE
                    ? alignedHighlights.slice(0, windowedSteps.length)
                    : alignedHighlights

                const tutorialPayload: TutorialPayload = {
                    title: planData.title || 'Step-by-step guide',
                    steps: windowedSteps,
                    plan: ADAPTIVE_SCREEN_MODE ? undefined : planData,
                    planStepOffset: ADAPTIVE_SCREEN_MODE ? 0 : currentRange.startIndex,
                }

                // Check for prior progress
                const fp = generateFingerprint(
                    window.location.origin,
                    tutorialPayload.title,
                    planData.planSteps.map(s => s.instruction)
                )
                setTutorialFingerprint(fp)

                let resumeStep = 0
                try {
                    const existing = await loadTutorialRecord(fp)
                    if (existing) {
                        const nextIncomplete = existing.steps.findIndex(s => !s.completed)
                        resumeStep = nextIncomplete >= 0 ? nextIncomplete : 0
                    } else {
                        const match = await findMatchingTutorial(window.location.origin, userMessage)
                        if (match && match.completedAt) {
                            setMessages(prev => [...prev, { sender: 'bot', text: `You've completed a similar tutorial ("${match.title}") before. Starting fresh but building on what you know!` }])
                        }
                    }

                    const record: TutorialRecord = {
                        fingerprint: fp,
                        origin: window.location.origin,
                        title: tutorialPayload.title,
                        query: userMessage,
                        steps: planData.planSteps.map(s => ({ instruction: s.instruction, completed: false })),
                        startedAt: Date.now(),
                        lastAccessedAt: Date.now(),
                        currentStepIndex: resumeStep,
                    }
                    await saveTutorialRecord(record)
                } catch (err) {
                    console.warn('Site Tutor: memory error', err)
                }

                console.log(`[Site Tutor] Plan-based tutorial: ${planData.totalSteps} total steps, ${currentPageTutorialSteps.length} on this page (range ${currentRange.startIndex}-${currentRange.endIndex})`)

                setMode('tutorial')
                setRestoredLastUrl(null)
                setTutorial(tutorialPayload)
                setCurrentTutorialStep(Math.max(
                    Math.min(resumeStep, windowedSteps.length - 1),
                    findFirstActionableStep(windowedSteps)
                ))
                setHighlights(buildHighlightsFromSteps(windowedSteps, windowedHighlights))
                setMessages(prev => [...prev, { sender: 'bot', text: resumeStep > 0 ? `Resuming tutorial from step ${resumeStep + 1}.` : 'Starting step-by-step tutorial. Use Next to move through each step.' }])
            } else if (!hasTutorialPlan) {
                // Fallback: try legacy flat step parsing
                const parsedSteps = extractNumberedSteps(data.text || '')
                if (parsedSteps) {
                    const adaptiveSteps = limitAdaptiveSteps(parsedSteps)
                    const adaptiveHighlights = Array.isArray(data.highlights)
                        ? data.highlights.slice(0, adaptiveSteps.length)
                        : data.highlights
                    const tutorialPayload = buildTutorialFromSteps(adaptiveSteps, adaptiveHighlights)

                    const fp = generateFingerprint(
                        window.location.origin,
                        tutorialPayload.title,
                        tutorialPayload.steps.map(s => s.instruction)
                    )
                    setTutorialFingerprint(fp)

                    let resumeStep = 0
                    try {
                        const existing = await loadTutorialRecord(fp)
                        if (existing) {
                            const nextIncomplete = existing.steps.findIndex(s => !s.completed)
                            resumeStep = nextIncomplete >= 0 ? nextIncomplete : 0
                        } else {
                            const match = await findMatchingTutorial(window.location.origin, userMessage)
                            if (match && match.completedAt) {
                                setMessages(prev => [...prev, { sender: 'bot', text: `You've completed a similar tutorial ("${match.title}") before. Starting fresh but building on what you know!` }])
                            }
                        }

                        const record: TutorialRecord = {
                            fingerprint: fp,
                            origin: window.location.origin,
                            title: tutorialPayload.title,
                            query: userMessage,
                            steps: tutorialPayload.steps.map(s => ({ instruction: s.instruction, completed: false })),
                            startedAt: Date.now(),
                            lastAccessedAt: Date.now(),
                            currentStepIndex: resumeStep,
                        }
                        await saveTutorialRecord(record)
                    } catch (err) {
                        console.warn('Site Tutor: memory error', err)
                    }

                    setMode('tutorial')
                    setRestoredLastUrl(null)
                    setTutorial(tutorialPayload)
                    setCurrentTutorialStep(Math.max(resumeStep, findFirstActionableStep(tutorialPayload.steps)))
                    setHighlights(buildHighlightsFromSteps(tutorialPayload.steps, adaptiveHighlights))
                    setMessages(prev => [...prev, { sender: 'bot', text: resumeStep > 0 ? `Resuming tutorial from step ${resumeStep + 1}.` : 'Starting step-by-step tutorial. Use Next to move through each step.' }])
                } else {
                    setMessages(prev => [...prev, { sender: 'bot', text: data.text }])

                    // Set highlights
                    if (data.highlights && data.highlights.length > 0) {
                        setHighlights(data.highlights)
                        console.log('Site Tutor: Received highlights:', data.highlights)
                    }
                }
            } else {
                // Non-tutorial request: stay in chat mode, show normal response and highlights.
                setMode('idle')
                setMessages(prev => [...prev, { sender: 'bot', text: data.text }])
                if (data.highlights && data.highlights.length > 0) {
                    setHighlights(data.highlights)
                    console.log('Site Tutor: Received highlights (non-tutorial mode):', data.highlights)
                }
            }

            // Handle automation actions
            if (data.automation) {
                const automation: AutomationAction = data.automation
                if (automation.type === 'navigate' && automation.url) {
                    // Give user a moment to read the message, then navigate
                    setTimeout(() => {
                        window.location.href = automation.url!
                    }, 1500)
                } else if (automation.type === 'click' && automation.selector) {
                    // Auto-click the specified element
                    setTimeout(() => {
                        const element = document.querySelector(automation.selector!)
                        if (element && element instanceof HTMLElement) {
                            element.click()
                            console.log('Auto-clicked element:', automation.selector)
                        } else {
                            console.warn('Element not found for auto-click:', automation.selector)
                        }
                    }, 1000)
                }
            }

        } catch (error) {
            console.error('Error:', error)
            setMessages(prev => [...prev, { sender: 'bot', text: 'turn the back end on' }])
        } finally {
            setLoading(false)
        }
    }


    return (
        <>
            <Overlay
                highlights={highlights}
                currentStepIndex={mode === 'tutorial' ? currentTutorialStep : undefined}
            />

            <div className="fixed bottom-6 right-6 z-[99999] font-sans text-gray-800 antialiased pointer-events-auto">
                <AnimatePresence>
                    {isOpen && (
                        <motion.div
                            className="chat-container pointer-events-auto"
                            initial={{ opacity: 0, scale: 0.8, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.8, y: 20 }}
                            data-mode={mode}
                        >
                            <div className="chat-header" data-mode={mode}>
                                <MessageCircle size={20} />
                                <span className="font-medium">
                                    {mode === 'tutorial' ? 'githack' : 'Site Tutor'}
                                </span>
                                {mode === 'tutorial' && tutorial && (
                                    <span className="ml-2 text-[11px] px-2.5 py-1 rounded-md bg-emerald-700 text-emerald-50 border border-emerald-500 font-semibold">
                                        Step {currentStepNumber}/{totalTutorialSteps}
                                    </span>
                                )}
                                <div className="relative ml-2">
                                    <button
                                        type="button"
                                        onMouseEnter={() => setShowVersionInfo(true)}
                                        onMouseLeave={() => setShowVersionInfo(false)}
                                        onFocus={() => setShowVersionInfo(true)}
                                        onBlur={() => setShowVersionInfo(false)}
                                        title={`Previous version: v${PREVIOUS_VERSION}`}
                                        className="text-[11px] px-2.5 py-1 rounded-md bg-slate-900 text-slate-50 border border-slate-700 font-medium shadow-sm hover:bg-slate-800 transition-colors"
                                        aria-label={`Current version v${VERSION}. Hover to see previous version.`}
                                    >
                                        v{VERSION}
                                    </button>
                                    {showVersionInfo && (
                                        <div
                                            className="absolute left-0 top-full mt-2 text-[11px] px-3 py-1.5 rounded-md bg-white text-slate-900 border border-slate-300 shadow-lg whitespace-nowrap z-[100000] pointer-events-none"
                                            aria-live="polite"
                                        >
                                            Previous version: v{PREVIOUS_VERSION}
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => setIsOpen(false)}
                                    className="ml-auto hover:bg-white/20 p-1 rounded transition-colors"
                                    aria-label="Close chat"
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            <div className="chat-body">
                                {mode === 'tutorial' && tutorial ? (
                                    <TutorialController
                                        tutorial={tutorial}
                                        sessionId={sessionId}
                                        initialStepIndex={currentTutorialStep}
                                        initialLastUrl={restoredLastUrl || undefined}
                                        tutorialFingerprint={tutorialFingerprint || undefined}
                                        llmVerifier={llmVerifierRef.current}
                                        routeTracker={routeTrackerRef.current}
                                        onStepChange={(index) => {
                                            // Mark previous step as completed when advancing
                                            if (index > currentTutorialStep && tutorialFingerprint) {
                                                markStepCompleted(tutorialFingerprint, currentTutorialStep).catch(() => {})
                                            }
                                            setCurrentTutorialStep(index)
                                        }}
                                        onAdaptiveRecalculate={async () => {
                                            return recalculateTutorialForCurrentPage(
                                                'manual-verified-step',
                                                `manual:${window.location.href}:${Date.now()}`
                                            )
                                        }}
                                        onPageTransitionSteps={(newSteps: TutorialStep[], newOffset: number) => {
                                            const hydratedSteps = fillMissingStepElementIndices(newSteps)
                                            setTutorial(prev => prev ? {
                                                ...prev,
                                                steps: hydratedSteps,
                                                planStepOffset: newOffset,
                                            } : null)
                                            setCurrentTutorialStep(findFirstActionableStep(hydratedSteps))
                                            setHighlights(buildHighlightsFromSteps(hydratedSteps))
                                        }}
                                        onComplete={handleTutorialComplete}
                                        onClose={handleReset}
                                    />
                                ) : (
                                    <>
                                        <div className="messages-container">
                                            {messages.map((msg, idx) => (
                                                <div
                                                    key={idx}
                                                    className={`message ${msg.sender === 'user' ? 'message-user' : 'message-bot'}`}
                                                >
                                                    <div
                                                        className="message-content"
                                                        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }}
                                                    />
                                                </div>
                                            ))}
                                            <div ref={messagesEndRef} />
                                        </div>

                                        <div className="chat-input-area">
                                            <input
                                                type="text"
                                                value={input}
                                                onChange={(e) => setInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                    e.stopPropagation()
                                                    if (e.key === 'Enter' && !loading) {
                                                        e.preventDefault()
                                                        handleSend()
                                                    }
                                                }}
                                                placeholder="Ask a question or request a tutorial..."
                                                disabled={loading}
                                                className="chat-input"
                                            />
                                            <button
                                                onClick={handleSend}
                                                disabled={loading}
                                                className="chat-send-button"
                                                aria-label="Send message"
                                            >
                                                {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {!isOpen && (
                    <motion.button
                        className="chat-fab pointer-events-auto"
                        onClick={() => setIsOpen(true)}
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.95 }}
                        data-mode={mode}
                        aria-label="Open chat"
                    >
                        <MessageCircle size={24} />
                        {mode === 'tutorial' && tutorial && (
                            <span className="absolute -top-1 -right-1 text-[10px] leading-none px-1.5 py-1 rounded-full bg-emerald-700 text-emerald-50 border border-emerald-500 font-semibold">
                                {currentStepNumber}
                            </span>
                        )}
                    </motion.button>
                )}
            </div>
        </>
    )
}

export default Chatbot
