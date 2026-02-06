import React, { useState, useRef, useEffect, useCallback } from 'react'
import { MessageCircle, X, Send, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Overlay from './Overlay'
import TutorialController from './TutorialController'
import type { TutorialActionType, TutorialPayload, TutorialPlan, TutorialStep } from '../types/tutorial'
import { ElementIndexer } from '../utils/elementIndexer'
import { LLMVerifier } from '../utils/llmVerifier'
import { RouteTracker } from '../utils/routeTracker'
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
}

interface AutomationAction {
    type: string
    url?: string
    selector?: string
}

const getIndexer = (): ElementIndexer => {
    const win = window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }
    if (!win.__siteTutorElementIndexer) {
        win.__siteTutorElementIndexer = new ElementIndexer()
    }
    return win.__siteTutorElementIndexer
}

const compressScreenshot = async (dataUrl: string): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            const canvas = document.createElement('canvas')
            const ctx = canvas.getContext('2d')
            if (!ctx) {
                reject(new Error('Could not get canvas context'))
                return
            }

            const maxWidth = 1920
            const maxHeight = 1080
            let width = img.width
            let height = img.height

            if (width > maxWidth || height > maxHeight) {
                const ratio = Math.min(maxWidth / width, maxHeight / height)
                width = Math.floor(width * ratio)
                height = Math.floor(height * ratio)
            }

            canvas.width = width
            canvas.height = height
            ctx.drawImage(img, 0, 0, width, height)

            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob)
                    } else {
                        reject(new Error('Failed to compress image'))
                    }
                },
                'image/jpeg',
                0.75
            )
        }
        img.onerror = () => reject(new Error('Failed to load image'))
        img.src = dataUrl
    })
}

const STORAGE_KEY_PREFIX = 'siteTutorState'
const FALLBACK_STORAGE_KEY = `${STORAGE_KEY_PREFIX}:default`
const GLOBAL_UI_STATE_KEY = `${STORAGE_KEY_PREFIX}:ui`
const PENDING_NAV_KEY = 'siteTutor:pendingNavigation'
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

    return steps.length >= 2 ? steps : null
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

const buildTutorialFromSteps = (steps: string[], highlights?: Highlight[]): TutorialPayload => {
    return {
        title: 'Step-by-step guide',
        steps: steps.map((instruction, index) => ({
            stepNumber: index + 1,
            selector: highlights?.[index]?.selector ?? '',
            instruction,
            actionType: inferActionType(instruction),
            expectedResult: undefined,
            elementIndex: highlights?.[index]?.elementIndex
        }))
    }
}

const buildHighlightsFromSteps = (steps: TutorialPayload['steps'], highlights?: Highlight[]): Highlight[] => {
    return steps.map((step, index) => ({
        selector: highlights?.[index]?.selector ?? step.selector ?? '',
        explanation: step.instruction,
        elementIndex: highlights?.[index]?.elementIndex ?? step.elementIndex
    }))
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

// Hardcoded example tutorial for creating a new GitHub repository
const EXAMPLE_CREATE_REPO_TUTORIAL: TutorialPayload = {
    title: 'Create a New GitHub Repository',
    steps: [
        {
            stepNumber: 1,
            selector: 'a[href="/new"]',
            instruction: 'Click the "New" button or repository creation link in the top right corner of GitHub.',
            actionType: 'click',
            expectedResult: 'repository creation form'
        },
        {
            stepNumber: 2,
            selector: 'input[name="repository[name]"]',
            instruction: 'Enter a name for your repository in the "Repository name" field.',
            actionType: 'input',
            expectedResult: 'repository name'
        },
        {
            stepNumber: 3,
            selector: 'input[name="repository[description]"]',
            instruction: '(Optional) Add a description for your repository.',
            actionType: 'input',
            expectedResult: 'description'
        },
        {
            stepNumber: 4,
            selector: 'input[name="repository[visibility]"][value="public"]',
            instruction: 'Choose the visibility: Public (anyone can see) or Private (only you).',
            actionType: 'click',
            expectedResult: 'visibility'
        },
        {
            stepNumber: 5,
            selector: 'button[type="submit"]',
            instruction: 'Click the "Create repository" button at the bottom of the form.',
            actionType: 'click',
            expectedResult: '/new'
        }
    ]
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
    const lastDynamicRecalcUrlRef = useRef('')

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

    const recalculateTutorialForCurrentPage = useCallback(async (reason: string = 'page-changed') => {
        if (mode !== 'tutorial' || !tutorial) return

        const currentUrl = window.location.href
        if (dynamicRecalcInFlightRef.current) return
        if (lastDynamicRecalcUrlRef.current === currentUrl) return

        console.log(`🔄 [Site Tutor] Dynamic recalculation start | reason=${reason} | url=${currentUrl}`)
        dynamicRecalcInFlightRef.current = true
        lastDynamicRecalcUrlRef.current = currentUrl

        try {
            const formData = new FormData()
            formData.append(
                'message',
                'Continue the active tutorial on this current page. Recalculate the next actionable steps for this page and return accurate highlights.'
            )

            if (sessionId) {
                formData.append('sessionId', sessionId)
            }

            const tutorialContext = {
                title: tutorial.title,
                currentStepIndex: currentTutorialStep,
                totalSteps: tutorial.steps.length,
                currentStep: tutorial.steps[currentTutorialStep]?.instruction ?? '',
                steps: tutorial.steps.map(step => step.instruction),
                recalculationReason: reason,
                currentUrl,
            }
            formData.append('tutorialContext', JSON.stringify(tutorialContext))

            const indexer = getIndexer()
            indexer.indexPage(document)
            const domText = indexer.toTextRepresentation(true)
            const viewportSummary = indexer.getViewportSummary()
            formData.append('dom', domText)
            formData.append('viewportInfo', viewportSummary)
            formData.append('scrollPosition', String(window.scrollY))
            console.log(`🧠 [Site Tutor] DOM forwarded to /chat (dynamic) | chars=${domText.length} | url=${currentUrl}`)

            console.log('📡 [Site Tutor] POST /chat (dynamic recalculation)')
            const response = await fetch('http://localhost:8000/chat', {
                method: 'POST',
                body: formData,
            })
            if (!response.ok) {
                throw new Error(`Recalculation failed: ${response.status}`)
            }

            const data = await response.json()
            if (data.sessionId && !sessionId) {
                setSessionId(data.sessionId)
            }

            const planData = data.tutorialPlan as TutorialPlan | undefined
            if (planData && planData.planSteps && planData.planSteps.length > 0) {
                const currentRange = planData.currentPageRange ?? { startIndex: 0, endIndex: 0 }
                const currentPagePlanSteps = planData.planSteps.slice(
                    currentRange.startIndex,
                    currentRange.endIndex + 1
                )
                const currentPageHighlights = planData.currentPageHighlights ?? data.highlights ?? []
                const normalizedHighlights: Highlight[] = currentPageHighlights.map((h: any) => ({
                    selector: h?.selector ?? '',
                    explanation: h?.explanation ?? '',
                    elementIndex: h?.elementIndex,
                }))

                const currentPageTutorialSteps: TutorialStep[] = currentPagePlanSteps.map((ps, idx) => ({
                    stepNumber: ps.stepNumber,
                    selector: normalizedHighlights[idx]?.selector ?? '',
                    instruction: ps.instruction,
                    actionType: ps.actionType ?? inferActionType(ps.instruction),
                    expectedResult: ps.expectedResult,
                    elementIndex: normalizedHighlights[idx]?.elementIndex,
                }))

                const tutorialPayload: TutorialPayload = {
                    title: planData.title || tutorial.title || 'Step-by-step guide',
                    steps: currentPageTutorialSteps,
                    plan: planData,
                    planStepOffset: currentRange.startIndex,
                }

                setMode('tutorial')
                setTutorial(tutorialPayload)
                setCurrentTutorialStep(0)
                setHighlights(buildHighlightsFromSteps(currentPageTutorialSteps, normalizedHighlights))
                console.log(`✅ [Site Tutor] Dynamic recalculation applied | newSteps=${currentPageTutorialSteps.length}`)
                return
            }

            const parsedSteps = extractNumberedSteps(data.text || '')
            if (parsedSteps && parsedSteps.length > 0) {
                const tutorialPayload = buildTutorialFromSteps(parsedSteps, data.highlights)
                setMode('tutorial')
                setTutorial(tutorialPayload)
                setCurrentTutorialStep(0)
                setHighlights(buildHighlightsFromSteps(tutorialPayload.steps, data.highlights))
                console.log(`✅ [Site Tutor] Dynamic recalculation applied from text steps | newSteps=${parsedSteps.length}`)
            }
        } catch (error) {
            console.warn('❌ [Site Tutor] Dynamic tutorial recalculation failed', error)
            // Allow retry on next page-change signal if this attempt failed.
            lastDynamicRecalcUrlRef.current = ''
        } finally {
            console.log('🏁 [Site Tutor] Dynamic recalculation finished')
            dynamicRecalcInFlightRef.current = false
        }
    }, [mode, tutorial, sessionId, currentTutorialStep])

    // Re-index DOM and refresh highlights when the URL changes (SPA or traditional navigation)
    useEffect(() => {
        const handlePageChanged = () => {
            console.log(`🧭 [Site Tutor] siteTutor:pageChanged | url=${window.location.href}`)
            console.log('🧠 [Site Tutor] Re-indexing DOM due to page change')
            const indexer = getIndexer()
            indexer.indexPage(document)

            // If in tutorial mode, refresh the highlights from the current tutorial steps
            if (tutorial && mode === 'tutorial') {
                setHighlights(buildHighlightsFromSteps(tutorial.steps))
                // Fallback for static/no-plan sessions: re-query backend for fresh page steps.
                if (!tutorial.plan || !sessionId) {
                    console.log('🆘 [Site Tutor] No plan/session transition path; triggering dynamic /chat fallback recalculation')
                    void recalculateTutorialForCurrentPage('page-changed-fallback')
                }
            }
        }

        window.addEventListener('siteTutor:pageChanged', handlePageChanged)
        return () => {
            window.removeEventListener('siteTutor:pageChanged', handlePageChanged)
        }
    }, [tutorial, mode, sessionId, recalculateTutorialForCurrentPage])

    useEffect(() => {
        if (mode !== 'tutorial' || !tutorial) {
            dynamicRecalcInFlightRef.current = false
            lastDynamicRecalcUrlRef.current = ''
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
            if (stored && stored.origin === window.location.origin) {
                setTutorial(stored.tutorial)
                setCurrentTutorialStep(stored.currentTutorialStep)
                setIsOpen(stored.isOpen || globalIsOpen)
                setRestoredLastUrl(restoredUrl)
                setSessionId(stored.sessionId ?? null)
                if (stored.tutorial) {
                    setMode('tutorial')
                    setHighlights(buildHighlightsFromSteps(stored.tutorial.steps))
                } else {
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
                    setMode('tutorial')
                    setHighlights(buildHighlightsFromSteps(session.tutorial.steps))
                } else {
                    setHighlights([])
                }
                if (didAdvanceForUrlChange) {
                    clearPendingNavigationForTab(tabId)
                }
            } else {
                const openState = stored?.isOpen ?? session?.isOpen ?? globalIsOpen
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

    const isCreateRepoRequest = (message: string): boolean => {
        const normalized = message.toLowerCase().trim()
        const patterns = [
            'create a new repo',
            'create new repo',
            'create a repo',
            'create repo',
            'make a new repo',
            'make new repo',
            'new repository',
            'create repository',
            'create a new repository',
            'create new repository'
        ]
        return patterns.some(pattern => normalized.includes(pattern))
    }

    const exitTutorial = () => {
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
        setTutorialFingerprint(null)
        exitTutorial()
        setHighlights([])
    }

    const handleReset = () => {
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
        console.log(`💬 [Site Tutor] User message -> /chat | url=${window.location.href} | text="${userMessage}"`)
        setInput('')
        setLoading(true)
        setHighlights([])

        // Check for hardcoded tutorial request
        if (isCreateRepoRequest(userMessage)) {
            setLoading(false)
            setMode('tutorial')
            setRestoredLastUrl(null)
            setTutorial(EXAMPLE_CREATE_REPO_TUTORIAL)
            setHighlights(buildHighlightsFromSteps(EXAMPLE_CREATE_REPO_TUTORIAL.steps))
            setCurrentTutorialStep(0)
            return
        }

        setMode('idle')
        setMessages(prev => [...prev, { sender: 'user', text: userMessage }])

        try {
            let screenshotDataUrl = ''

            // Always try desktop screenshot first for better context
            console.log('[Screenshot] Using desktop capture')
            try {
                const desktopResponse = await fetch('http://localhost:8000/capture-desktop')
                if (desktopResponse.ok) {
                    const desktopData = await desktopResponse.json()
                    screenshotDataUrl = `data:image/png;base64,${desktopData.screenshot}`
                    console.log('[Screenshot] Desktop screenshot captured successfully')
                } else {
                    console.error('[Screenshot] Desktop capture failed, falling back to tab capture')
                }
            } catch (error) {
                console.error('[Screenshot] Desktop capture error:', error)
            }

            // Fallback to Chrome tab capture if desktop capture failed
            if (!screenshotDataUrl) {
                console.log('[Screenshot] Using Chrome tab capture as fallback')
                screenshotDataUrl = await new Promise<string>((resolve) => {
                    chrome.runtime.sendMessage({ action: 'captureScreen' }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error('[Screenshot] Tab capture error:', chrome.runtime.lastError)
                            resolve('')
                        } else {
                            resolve(response?.dataUrl || '')
                        }
                    })
                })
            }

            // Prepare Form Data
            const formData = new FormData()
            formData.append('message', userMessage)

            // Include session ID if we have one
            if (sessionId) {
                formData.append('sessionId', sessionId)
            }

            if (tutorial && mode === 'tutorial') {
                const tutorialContext = {
                    title: tutorial.title,
                    currentStepIndex: currentTutorialStep,
                    totalSteps: tutorial.steps.length,
                    currentStep: tutorial.steps[currentTutorialStep]?.instruction ?? '',
                    steps: tutorial.steps.map(step => step.instruction),
                }
                formData.append('tutorialContext', JSON.stringify(tutorialContext))
            }

            if (screenshotDataUrl) {
                // Compress and convert data URL to blob
                const compressedBlob = await compressScreenshot(screenshotDataUrl)
                formData.append('screenshot', compressedBlob, 'screenshot.jpg')
                console.log('[Screenshot] Screenshot attached to request')
            } else {
                console.warn('[Screenshot] No screenshot available to send')
            }

            // Add indexed DOM context with viewport information
            try {
                const indexer = getIndexer()
                indexer.indexPage(document)
                const domText = indexer.toTextRepresentation(true)  // Include viewport annotations
                const viewportSummary = indexer.getViewportSummary()
                formData.append('dom', domText)
                formData.append('viewportInfo', viewportSummary)
                formData.append('scrollPosition', String(window.scrollY))
                console.log(`🧠 [Site Tutor] DOM forwarded to /chat | chars=${domText.length} | scrollY=${window.scrollY}`)
            } catch (err) {
                console.warn('⚠️ [Site Tutor] Unable to generate indexed DOM', err)
            }

            // Add completion history
            try {
                const history = await getCompletionHistory(window.location.origin)
                if (history.length > 0) {
                    const summary = history.map(h => `- ${h.title}`).join('\n')
                    formData.append('completionHistory', summary)
                }
            } catch (err) {
                console.warn('Site Tutor: unable to load completion history', err)
            }

            // Call Backend
            console.log('📡 [Site Tutor] POST /chat')
            const response = await fetch('http://localhost:8000/chat', {
                method: 'POST',
                body: formData
            })

            const data = await response.json()

            // Store session ID from response
            if (data.sessionId && !sessionId) {
                setSessionId(data.sessionId)
                console.log('Session ID received:', data.sessionId)
            }

            // Check if the response includes a tutorial plan (two-tier response)
            const planData = data.tutorialPlan as TutorialPlan | undefined

            if (planData && planData.planSteps && planData.planSteps.length > 0) {
                // Two-tier plan response: build tutorial from current-page steps only
                const currentRange = planData.currentPageRange ?? { startIndex: 0, endIndex: 0 }
                const currentPagePlanSteps = planData.planSteps.slice(
                    currentRange.startIndex,
                    currentRange.endIndex + 1
                )
                const currentPageHighlights = planData.currentPageHighlights ?? data.highlights ?? []

                const currentPageTutorialSteps: TutorialStep[] = currentPagePlanSteps.map((ps, idx) => ({
                    stepNumber: ps.stepNumber,
                    selector: currentPageHighlights[idx]?.selector ?? '',
                    instruction: ps.instruction,
                    actionType: ps.actionType ?? inferActionType(ps.instruction),
                    expectedResult: ps.expectedResult,
                    elementIndex: currentPageHighlights[idx]?.elementIndex,
                }))

                const tutorialPayload: TutorialPayload = {
                    title: planData.title || 'Step-by-step guide',
                    steps: currentPageTutorialSteps,
                    plan: planData,
                    planStepOffset: currentRange.startIndex,
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
                setCurrentTutorialStep(Math.min(resumeStep, currentPageTutorialSteps.length - 1))
                setHighlights(buildHighlightsFromSteps(currentPageTutorialSteps))
                setMessages(prev => [...prev, { sender: 'bot', text: resumeStep > 0 ? `Resuming tutorial from step ${resumeStep + 1}.` : 'Starting step-by-step tutorial. Use Next to move through each step.' }])
            } else {
                // Fallback: try legacy flat step parsing
                const parsedSteps = extractNumberedSteps(data.text || '')
                if (parsedSteps) {
                    const tutorialPayload = buildTutorialFromSteps(parsedSteps, data.highlights)

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
                    setCurrentTutorialStep(resumeStep)
                    setHighlights(buildHighlightsFromSteps(tutorialPayload.steps, data.highlights))
                    setMessages(prev => [...prev, { sender: 'bot', text: resumeStep > 0 ? `Resuming tutorial from step ${resumeStep + 1}.` : 'Starting step-by-step tutorial. Use Next to move through each step.' }])
                } else {
                    setMessages(prev => [...prev, { sender: 'bot', text: data.text }])

                    // Set highlights
                    if (data.highlights && data.highlights.length > 0) {
                        setHighlights(data.highlights)
                        console.log('Site Tutor: Received highlights:', data.highlights)
                    }
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
                                        onPageTransitionSteps={(newSteps: TutorialStep[], newOffset: number) => {
                                            setTutorial(prev => prev ? {
                                                ...prev,
                                                steps: newSteps,
                                                planStepOffset: newOffset,
                                            } : null)
                                            setCurrentTutorialStep(0)
                                            setHighlights(buildHighlightsFromSteps(newSteps))
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
