import React, { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Overlay from './Overlay'
import TutorialController from './TutorialController'
import type { TutorialActionType, TutorialPayload } from '../types/tutorial'
import { ElementIndexer } from '../utils/elementIndexer'
import {
    generateFingerprint,
    saveTutorialRecord,
    loadTutorialRecord,
    findMatchingTutorial,
    markStepCompleted,
    getCompletionHistory,
    type TutorialRecord,
} from '../utils/tutorialMemory'

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
    taskId?: string
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
const extractNumberedSteps = (text: string, maxSteps?: number): string[] | null => {
    const lines = text.split(/\r?\n/).map(line => line.trim())
    const steps: string[] = []
    let current = ''

    lines.forEach(line => {
        if (!line) return
        // Stop if we've reached the max steps limit
        if (maxSteps && steps.length >= maxSteps && current.length === 0) return

        const match = line.match(/^\s*\d+(?:\.|\))\s+(.*)$/)
        if (match) {
            if (current.length > 0) {
                steps.push(current.trim())
                // Stop if we've reached max steps after pushing
                if (maxSteps && steps.length >= maxSteps) return
            }
            current = match[1].trim()
            return
        }

        if (current.length > 0) {
            current += ` ${line}`
        }
    })

    if (current.length > 0 && (!maxSteps || steps.length < maxSteps)) {
        steps.push(current.trim())
    }

    return steps.length >= 1 ? steps : null
}

const extractTotalStepsHint = (text: string): number | null => {
    // Try to extract total step count from hints like "This will take about 5 steps"
    const patterns = [
        /(\d+)\s+steps?\s+total/i,
        /take\s+(?:about|approximately)?\s*(\d+)\s+steps?/i,
        /total\s+of\s+(\d+)\s+steps?/i
    ]

    for (const pattern of patterns) {
        const match = text.match(pattern)
        if (match && match[1]) {
            return parseInt(match[1], 10)
        }
    }
    return null
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
            expectedResult: 'repository creation form',
            hint: 'Look for a green button with a plus icon or a "New" link in the header navigation.'
        },
        {
            stepNumber: 2,
            selector: 'input[name="repository[name]"]',
            instruction: 'Enter a name for your repository in the "Repository name" field.',
            actionType: 'input',
            expectedResult: 'repository name',
            hint: 'The field is usually at the top of the form. Use a descriptive name like "my-project".'
        },
        {
            stepNumber: 3,
            selector: 'input[name="repository[description]"]',
            instruction: '(Optional) Add a description for your repository.',
            actionType: 'input',
            expectedResult: 'description',
            hint: 'This step is optional - you can skip it and click Next if you prefer.'
        },
        {
            stepNumber: 4,
            selector: 'input[name="repository[visibility]"][value="public"]',
            instruction: 'Choose the visibility: Public (anyone can see) or Private (only you).',
            actionType: 'click',
            expectedResult: 'visibility',
            hint: 'Public repositories are free and visible to everyone. Private repositories require a paid plan.'
        },
        {
            stepNumber: 5,
            selector: 'button[type="submit"]',
            instruction: 'Click the "Create repository" button at the bottom of the form.',
            actionType: 'click',
            expectedResult: '/new',
            hint: 'The button is usually green and located at the bottom of the form.'
        }
    ]
}

interface StoredState {
    tutorial: TutorialPayload | null
    currentTutorialStep: number
    isOpen: boolean
    origin?: string
}

interface SessionSnapshot {
    tutorial: TutorialPayload | null
    currentTutorialStep: number
    isOpen: boolean
    origin: string
    lastUrl: string
    updatedAt: number
}

type SessionStore = Record<string, SessionSnapshot>

type ChatMode = 'tutorial' | 'idle'

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [mode, setMode] = useState<ChatMode>('idle')
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)

    // Chat state
    const [messages, setMessages] = useState<Message[]>([
        { sender: 'bot', text: "Hi! I'm your Site Tutor. I can teach you anything about this website. Ask a question or request a tutorial!" }
    ])
    const [highlights, setHighlights] = useState<Highlight[]>([])
    const [sessionId, setSessionId] = useState<string | null>(null)
    const [automationStatus, setAutomationStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
    const [automationProgress, setAutomationProgress] = useState<string[]>([])

    // Tutorial mode state
    const [tutorial, setTutorial] = useState<TutorialPayload | null>(null)
    const [currentTutorialStep, setCurrentTutorialStep] = useState(0)
    const [isRestoring, setIsRestoring] = useState(true)
    const [storageKey, setStorageKey] = useState<string | null>(null)
    const [tabId, setTabId] = useState<number | null>(null)
    const [tutorialFingerprint, setTutorialFingerprint] = useState<string | null>(null)

    // Incremental step generation state
    const [originalQuery, setOriginalQuery] = useState<string>('')
    const [completedStepDescriptions, setCompletedStepDescriptions] = useState<string[]>([])
    const [isRegenerating, setIsRegenerating] = useState(false)
    const [totalExpectedSteps, setTotalExpectedSteps] = useState<number | null>(null)

    const messagesEndRef = useRef<HTMLDivElement>(null)

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
            setStorageKey(key)
        })
    }, [])

    // Restore tutorial state from storage
    useEffect(() => {
        if (!storageKey) return

        // Check if chrome.storage is available
        if (!chrome?.storage?.local) {
            console.warn('Site Tutor: chrome.storage not available')
            setIsRestoring(false)
            return
        }

        chrome.storage.local.get([storageKey, SESSION_STORE_KEY], (result) => {
            if (chrome.runtime.lastError) {
                console.warn('Failed to load state:', chrome.runtime.lastError)
                setIsRestoring(false)
                return
            }

            const stored = result[storageKey] as StoredState | undefined
            const sessionStore = result[SESSION_STORE_KEY] as SessionStore | undefined
            const session = tabId !== null ? sessionStore?.[String(tabId)] : undefined

            if (stored && stored.origin === window.location.origin) {
                setTutorial(stored.tutorial)
                setCurrentTutorialStep(stored.currentTutorialStep)
                setIsOpen(stored.isOpen)
                if (stored.tutorial) {
                    setMode('tutorial')
                    setHighlights(buildHighlightsFromSteps(stored.tutorial.steps))
                } else {
                    setHighlights([])
                }
            } else if (session && session.origin === window.location.origin) {
                const nextStepIndex = session.lastUrl !== window.location.href && session.tutorial
                    ? Math.min(session.currentTutorialStep + 1, session.tutorial.steps.length - 1)
                    : session.currentTutorialStep

                setTutorial(session.tutorial)
                setCurrentTutorialStep(nextStepIndex)
                setIsOpen(session.isOpen)
                if (session.tutorial) {
                    setMode('tutorial')
                    setHighlights(buildHighlightsFromSteps(session.tutorial.steps))
                } else {
                    setHighlights([])
                }
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
            origin: window.location.origin
        }

        chrome.storage.local.set({ [storageKey]: state })
    }, [tutorial, currentTutorialStep, isOpen, storageKey, isRestoring])

    useEffect(() => {
        if (tabId === null || isRestoring) return
        if (!chrome?.storage?.local) return

        const snapshot: SessionSnapshot = {
            tutorial,
            currentTutorialStep,
            isOpen,
            origin: window.location.origin,
            lastUrl: window.location.href,
            updatedAt: Date.now()
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
        setMessages([
            { sender: 'bot', text: "Hi! I'm your Site Tutor. I can teach you anything about this website. Ask a question or request a tutorial!" }
        ])
        setAutomationStatus('idle')
        setAutomationProgress([])
        setOriginalQuery('')
        setCompletedStepDescriptions([])
        setIsRegenerating(false)
        setTotalExpectedSteps(null)
    }

    const captureScreenshot = async (): Promise<Blob | null> => {
        try {
            // Try desktop screenshot first
            const desktopResponse = await fetch('http://localhost:8000/capture-desktop')
            if (desktopResponse.ok) {
                const desktopData = await desktopResponse.json()
                const base64Data = desktopData.screenshot
                const binaryData = atob(base64Data)
                const bytes = new Uint8Array(binaryData.length)
                for (let i = 0; i < binaryData.length; i++) {
                    bytes[i] = binaryData.charCodeAt(i)
                }
                return new Blob([bytes], { type: 'image/png' })
            }
        } catch (error) {
            console.error('[Screenshot] Desktop capture failed:', error)
        }

        // Fallback to Chrome tab capture
        return new Promise<Blob | null>((resolve) => {
            chrome.runtime.sendMessage({ action: 'captureScreen' }, async (response) => {
                if (chrome.runtime.lastError || !response?.dataUrl) {
                    resolve(null)
                    return
                }
                const compressedBlob = await compressScreenshot(response.dataUrl)
                resolve(compressedBlob)
            })
        })
    }

    const fetchWithTimeout = (url: string, options: RequestInit, timeoutMs = 15000): Promise<Response> => {
        return Promise.race([
            fetch(url, options),
            new Promise<Response>((_, reject) =>
                setTimeout(() => reject(new Error('Request timed out')), timeoutMs)
            )
        ])
    }

    const handleStepVerificationAndRegeneration = async (completedStepIndex: number) => {
        if (!tutorial || !sessionId || !originalQuery) {
            // No session yet — skip verification, just regenerate next step
            setCurrentTutorialStep(prev => prev + 1)
            return
        }

        setIsRegenerating(true)

        try {
            // 1. Take fresh screenshot
            const screenshot = await captureScreenshot()
            if (!screenshot) {
                setCurrentTutorialStep(prev => prev + 1)
                setIsRegenerating(false)
                return
            }

            // 2. Verify step completion (skip if it fails/times out)
            let verified = true
            try {
                const verifyFormData = new FormData()
                verifyFormData.append('sessionId', sessionId)
                verifyFormData.append('stepIndex', completedStepIndex.toString())
                verifyFormData.append('stepDescription', tutorial.steps[completedStepIndex].instruction)
                verifyFormData.append('screenshot', screenshot, 'screenshot.jpg')
                verifyFormData.append('originalQuery', originalQuery)

                const verifyResponse = await fetchWithTimeout('http://localhost:8000/verify-step', {
                    method: 'POST',
                    body: verifyFormData
                })
                const verifyResult = await verifyResponse.json()
                verified = verifyResult.verified
                if (!verified) {
                    setMessages(prev => [...prev, { sender: 'bot', text: verifyResult.feedback }])
                    setIsRegenerating(false)
                    return
                }
            } catch {
                // Verification failed/timed out — proceed anyway
                console.warn('Step verification skipped (timeout or error)')
            }

            // 3. Mark step completed
            if (tutorialFingerprint) {
                markStepCompleted(tutorialFingerprint, completedStepIndex).catch(() => {})
            }

            const newCompletedSteps = [
                ...completedStepDescriptions,
                tutorial.steps[completedStepIndex].instruction
            ]
            setCompletedStepDescriptions(newCompletedSteps)

            // 4. Regenerate next step
            const indexer = getIndexer()
            indexer.indexPage(document)
            const domText = indexer.toTextRepresentation()

            const regenerateFormData = new FormData()
            regenerateFormData.append('sessionId', sessionId)
            regenerateFormData.append('originalQuery', originalQuery)
            regenerateFormData.append('completedSteps', JSON.stringify(newCompletedSteps))
            regenerateFormData.append('currentStepIndex', (completedStepIndex + 1).toString())
            regenerateFormData.append('screenshot', screenshot, 'screenshot.jpg')
            regenerateFormData.append('dom', domText)

            const regenerateResponse = await fetchWithTimeout('http://localhost:8000/regenerate-steps', {
                method: 'POST',
                body: regenerateFormData
            }, 20000)

            const { newSteps, isComplete } = await regenerateResponse.json()

            if (isComplete || newSteps.length === 0) {
                handleTutorialComplete()
                setMessages(prev => [...prev, { sender: 'bot', text: 'Tutorial complete! You\'ve accomplished your goal.' }])
            } else {
                const mappedSteps = newSteps.map((step: any, i: number) => ({
                    stepNumber: completedStepIndex + 2 + i,
                    instruction: step.instruction,
                    actionType: step.actionType || 'click',
                    selector: step.selector || '',
                    expectedResult: step.expectedResult,
                    hint: step.hint,
                    elementIndex: step.elementIndex
                }))

                const updatedSteps = [
                    ...tutorial.steps.slice(0, completedStepIndex + 1),
                    ...mappedSteps
                ]

                setTutorial(prev => {
                    if (!prev) return prev
                    return { ...prev, steps: updatedSteps }
                })

                // Update highlights for new steps
                setHighlights(buildHighlightsFromSteps(updatedSteps))

                // Advance to the new step
                setCurrentTutorialStep(completedStepIndex + 1)
            }

        } catch (error) {
            console.error('Error during verification/regeneration:', error)
            setMessages(prev => [...prev, { sender: 'bot', text: 'Having trouble generating the next step. Click Next to try again.' }])
        } finally {
            setIsRegenerating(false)
        }
    }

    const handleSend = async () => {
        if (!input.trim()) return

        const userMessage = input
        setInput('')
        setLoading(true)
        setHighlights([])

        // Store original query for step regeneration
        setOriginalQuery(userMessage)
        setCompletedStepDescriptions([])

        // Check for hardcoded tutorial request
        if (isCreateRepoRequest(userMessage)) {
            setLoading(false)
            setMode('tutorial')
            setTutorial(EXAMPLE_CREATE_REPO_TUTORIAL)
            setHighlights(buildHighlightsFromSteps(EXAMPLE_CREATE_REPO_TUTORIAL.steps))
            setCurrentTutorialStep(0)
            return
        }

        // Lux mode disabled: keep standard chat flow
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

            // Signal initial step generation mode
            formData.append('generateMode', 'initial')

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

            // Add indexed DOM context
            try {
                const indexer = getIndexer()
                indexer.indexPage(document)
                const domText = indexer.toTextRepresentation()
                formData.append('dom', domText)
            } catch (err) {
                console.warn('Site Tutor: unable to generate indexed DOM', err)
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

            // Extract only the first step for incremental generation
            const parsedSteps = extractNumberedSteps(data.text || '', 1)
            if (parsedSteps) {
                // Try to extract total expected steps from AI response
                const expectedTotal = extractTotalStepsHint(data.text || '')
                if (expectedTotal) {
                    setTotalExpectedSteps(expectedTotal)
                }

                const tutorialPayload = buildTutorialFromSteps(parsedSteps, data.highlights)

                // Check for prior progress on this tutorial
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
                        // Resume from where they left off
                        const nextIncomplete = existing.steps.findIndex(s => !s.completed)
                        resumeStep = nextIncomplete >= 0 ? nextIncomplete : 0

                        // Restore incremental generation state
                        if (existing.originalQuery) {
                            setOriginalQuery(existing.originalQuery)
                        }
                        if (existing.completedStepDescriptions) {
                            setCompletedStepDescriptions(existing.completedStepDescriptions)
                        }
                        if (existing.totalExpectedSteps) {
                            setTotalExpectedSteps(existing.totalExpectedSteps)
                        }
                    } else {
                        // Check for similar tutorial
                        const match = await findMatchingTutorial(window.location.origin, userMessage)
                        if (match && match.completedAt) {
                            setMessages(prev => [...prev, { sender: 'bot', text: `You've completed a similar tutorial ("${match.title}") before. Starting fresh but building on what you know!` }])
                        }
                    }

                    // Save new record
                    const record: TutorialRecord = {
                        fingerprint: fp,
                        origin: window.location.origin,
                        title: tutorialPayload.title,
                        query: userMessage,
                        steps: tutorialPayload.steps.map(s => ({ instruction: s.instruction, completed: false })),
                        startedAt: Date.now(),
                        lastAccessedAt: Date.now(),
                        currentStepIndex: resumeStep,
                        originalQuery: userMessage,
                        completedStepDescriptions: [],
                        totalExpectedSteps: totalExpectedSteps ?? undefined,
                    }
                    await saveTutorialRecord(record)
                } catch (err) {
                    console.warn('Site Tutor: memory error', err)
                }

                setMode('tutorial')
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
            setMessages(prev => [...prev, { sender: 'bot', text: 'Sorry, I encountered an error connecting to the brain.' }])
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
                                    {mode === 'tutorial' ? 'Tutorial Mode' : 'Site Tutor'}
                                </span>
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
                                        initialStepIndex={currentTutorialStep}
                                        onStepChange={(index) => {
                                            // Mark previous step as completed when advancing
                                            if (index > currentTutorialStep && tutorialFingerprint) {
                                                markStepCompleted(tutorialFingerprint, currentTutorialStep).catch(() => {})
                                            }
                                            setCurrentTutorialStep(index)
                                        }}
                                        onComplete={handleTutorialComplete}
                                        onClose={handleReset}
                                        onStepVerify={handleStepVerificationAndRegeneration}
                                        isRegenerating={isRegenerating}
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
                                            {automationProgress.length > 0 && (
                                                <div className="message message-bot">
                                                    <div className="text-sm font-semibold mb-1">Automation Progress:</div>
                                                    {automationProgress.map((progress, idx) => (
                                                        <div key={idx} className="text-xs opacity-80">{progress}</div>
                                                    ))}
                                                </div>
                                            )}
                                            <div ref={messagesEndRef} />
                                        </div>

                                        <div className="chat-input-area">
                                            <input
                                                type="text"
                                                value={input}
                                                onChange={(e) => setInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault()
                                                        if (!loading && automationStatus !== 'running') {
                                                            handleSend()
                                                        }
                                                    }
                                                }}
                                                placeholder="Ask a question or request a tutorial..."
                                                disabled={loading || automationStatus === 'running'}
                                                className="chat-input"
                                            />
                                            <button
                                                onClick={handleSend}
                                                disabled={loading || automationStatus === 'running'}
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
                    </motion.button>
                )}
            </div>
        </>
    )
}

export default Chatbot
