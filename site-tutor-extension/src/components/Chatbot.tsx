import React, { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send, Loader2, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Overlay from './Overlay'
import TutorialController from './TutorialController'
import type { TutorialPayload } from '../types/tutorial'
import { getSimplifiedDom } from '../utils/domSanitizer'

interface Message {
    sender: 'user' | 'bot'
    text: string
}

interface Highlight {
    selector: string
    explanation: string
}

interface AutomationAction {
    type: string
    url?: string
    selector?: string
    taskId?: string
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

type ChatMode = 'tutorial' | 'lux' | 'idle'

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [mode, setMode] = useState<ChatMode>('idle')
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)

    // Lux mode state
    const [messages, setMessages] = useState<Message[]>([
        { sender: 'bot', text: "Hi! I'm your Site Tutor. I can teach you anything about this website. Ask a question or request a tutorial!" }
    ])
    const [highlights, setHighlights] = useState<Highlight[]>([])
    const [sessionId, setSessionId] = useState<string | null>(null)
    const [automationStatus, setAutomationStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
    const [automationProgress, setAutomationProgress] = useState<string[]>([])
    const [luxEventSource, setLuxEventSource] = useState<EventSource | null>(null)

    // Tutorial mode state
    const [tutorial, setTutorial] = useState<TutorialPayload | null>(null)
    const [currentTutorialStep, setCurrentTutorialStep] = useState(0)
    const [isRestoring, setIsRestoring] = useState(true)
    const [storageKey, setStorageKey] = useState<string | null>(null)

    const messagesEndRef = useRef<HTMLDivElement>(null)

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

    // Cleanup EventSource on unmount
    useEffect(() => {
        return () => {
            if (luxEventSource) {
                luxEventSource.close()
            }
        }
    }, [luxEventSource])

    // Initialize storage key for tutorial persistence
    useEffect(() => {
        chrome.runtime.sendMessage({ action: 'getTabId' }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('Site Tutor: unable to determine tab id', chrome.runtime.lastError)
                setStorageKey(FALLBACK_STORAGE_KEY)
                return
            }

            const key = `${STORAGE_KEY_PREFIX}:${response?.tabId ?? 'default'}`
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

        chrome.storage.local.get([storageKey], (result) => {
            if (chrome.runtime.lastError) {
                console.warn('Failed to load state:', chrome.runtime.lastError)
                setIsRestoring(false)
                return
            }

            const stored = result[storageKey] as StoredState | undefined

            if (stored && stored.origin === window.location.origin) {
                setTutorial(stored.tutorial)
                setCurrentTutorialStep(stored.currentTutorialStep)
                setIsOpen(stored.isOpen)
                if (stored.tutorial) {
                    setMode('tutorial')
                }
            }

            setIsRestoring(false)
        })
    }, [storageKey])

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
    }

    const handleSend = async () => {
        if (!input.trim()) return

        const userMessage = input
        setInput('')
        setLoading(true)
        setHighlights([])

        // Check for hardcoded tutorial request
        if (isCreateRepoRequest(userMessage)) {
            setLoading(false)
            setMode('tutorial')
            setTutorial(EXAMPLE_CREATE_REPO_TUTORIAL)
            setCurrentTutorialStep(0)
            return
        }

        // Normal Lux mode flow
        setMode('lux')
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

            if (screenshotDataUrl) {
                // Compress and convert data URL to blob
                const compressedBlob = await compressScreenshot(screenshotDataUrl)
                formData.append('screenshot', compressedBlob, 'screenshot.jpg')
                console.log('[Screenshot] Screenshot attached to request')
            } else {
                console.warn('[Screenshot] No screenshot available to send')
            }

            // Add DOM context
            try {
                const domTree = getSimplifiedDom(document)
                formData.append('dom', JSON.stringify(domTree))
            } catch (err) {
                console.warn('Site Tutor: unable to generate sanitized DOM', err)
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

            setMessages(prev => [...prev, { sender: 'bot', text: data.text }])

            // Set highlights
            if (data.highlights && data.highlights.length > 0) {
                setHighlights(data.highlights)
                console.log('Site Tutor: Received highlights:', data.highlights)
            }

            // Handle automation actions
            if (data.automation) {
                const automation: AutomationAction = data.automation
                if (automation.type === 'lux' && automation.taskId) {
                    // Trigger LUX automation
                    handleLuxAutomation(userMessage, data.sessionId || sessionId)
                } else if (automation.type === 'navigate' && automation.url) {
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

    const handleLuxAutomation = async (userMessage: string, currentSessionId: string | null) => {
        if (!currentSessionId) {
            console.error('No session ID available for LUX automation')
            setMessages(prev => [...prev, { sender: 'bot', text: 'Error: Session not initialized' }])
            return
        }

        try {
            // Extract user intent from "I give up on X" pattern
            const intent = userMessage.replace(/i give up on/i, '').trim() ||
                          userMessage.replace(/just do it for me/i, 'this task').trim() ||
                          userMessage.replace(/you do it/i, 'this task').trim() ||
                          userMessage.replace(/i give up/i, 'this task').trim()

            console.log('[LUX] Starting automation for intent:', intent)

            // Show automation starting message
            setMessages(prev => [...prev, {
                sender: 'bot',
                text: `🤖 Starting automated execution... I'll take control of your computer to complete: ${intent}`
            }])

            setAutomationStatus('running')
            setAutomationProgress([])

            // Call automate endpoint
            const response = await fetch('http://localhost:8000/automate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: currentSessionId,
                    userIntent: intent
                })
            })

            if (!response.ok) {
                throw new Error(`Automation request failed: ${response.statusText}`)
            }

            const data = await response.json()
            console.log('[LUX] Automation started:', data)

            // Connect to SSE stream
            const eventSource = new EventSource(`http://localhost:8000${data.streamUrl}`)
            setLuxEventSource(eventSource)

            eventSource.addEventListener('task_generated', (e: Event) => {
                const taskData = JSON.parse((e as MessageEvent).data)
                console.log('[LUX] Task generated:', taskData)
                setMessages(prev => [...prev, {
                    sender: 'bot',
                    text: `📋 Task Plan:\n${taskData.task}\n\nSteps:\n${taskData.todos.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')}`
                }])
            })

            eventSource.addEventListener('step', (e: Event) => {
                const stepData = JSON.parse((e as MessageEvent).data)
                console.log('[LUX] Step:', stepData)
                setAutomationProgress(prev => [...prev, `Step ${stepData.step}: ${stepData.description}`])
            })

            eventSource.addEventListener('action', (e: Event) => {
                const actionData = JSON.parse((e as MessageEvent).data)
                console.log('[LUX] Action:', actionData)
                setAutomationProgress(prev => [...prev, `Action: ${actionData.actions}`])
            })

            eventSource.addEventListener('retry', (e: Event) => {
                const retryData = JSON.parse((e as MessageEvent).data)
                console.log('[LUX] Retry:', retryData)
                setMessages(prev => [...prev, {
                    sender: 'bot',
                    text: `🔄 Retrying (attempt ${retryData.attempt}): ${retryData.reason}`
                }])
            })

            eventSource.addEventListener('error', (e: Event) => {
                const errorData = JSON.parse((e as MessageEvent).data)
                console.error('[LUX] Error:', errorData)
                setAutomationStatus('error')
                setMessages(prev => [...prev, {
                    sender: 'bot',
                    text: `❌ Error during automation: ${errorData.error}`
                }])
                eventSource.close()
                setLuxEventSource(null)
            })

            eventSource.addEventListener('complete', (e: Event) => {
                const completeData = JSON.parse((e as MessageEvent).data)
                console.log('[LUX] Complete:', completeData)
                setAutomationStatus(completeData.success ? 'success' : 'error')
                setMessages(prev => [...prev, {
                    sender: 'bot',
                    text: completeData.success
                        ? `✅ Automation completed successfully!\n\n${completeData.summary}\n\n[View detailed report](http://localhost:8000${completeData.htmlReport})`
                        : `❌ Automation failed: ${completeData.summary}`
                }])
                eventSource.close()
                setLuxEventSource(null)
            })

            eventSource.addEventListener('done', () => {
                console.log('[LUX] Stream done')
                eventSource.close()
                setLuxEventSource(null)
            })

            eventSource.onerror = (error) => {
                console.error('[LUX] SSE Error:', error)
                setAutomationStatus('error')
                setMessages(prev => [...prev, {
                    sender: 'bot',
                    text: '❌ Lost connection to automation stream'
                }])
                eventSource.close()
                setLuxEventSource(null)
            }

        } catch (error) {
            console.error('[LUX] Automation error:', error)
            setAutomationStatus('error')
            setMessages(prev => [...prev, {
                sender: 'bot',
                text: `❌ Failed to start automation: ${error}`
            }])
        }
    }

    return (
        <>
            <Overlay
                highlights={highlights}
                currentStepIndex={mode === 'tutorial' ? currentTutorialStep : undefined}
            />

            <div className="fixed bottom-6 right-6 z-[99999] font-sans text-gray-800 antialiased">
                <AnimatePresence>
                    {isOpen && (
                        <motion.div
                            className="chat-container"
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
                                        onStepChange={setCurrentTutorialStep}
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
                                                    {msg.text}
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
                                                    if (e.key === 'Enter' && !loading) {
                                                        handleSend()
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
                                            {mode === 'lux' && (
                                                <button
                                                    onClick={handleReset}
                                                    className="chat-reset-button"
                                                    aria-label="Reset chat"
                                                    title="Reset chat"
                                                >
                                                    <RotateCcw size={16} />
                                                </button>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {!isOpen && (
                    <motion.button
                        className="chat-fab"
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
