import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageCircle, Send, X, RotateCcw } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import Overlay from './Overlay'
import TutorialController from './TutorialController'
import type { TutorialPayload } from '../types/tutorial'
import { getSimplifiedDom } from '../utils/domSanitizer'

interface Highlight {
    selector: string
    explanation: string
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

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [highlights, setHighlights] = useState<Highlight[]>([])
    const [tutorial, setTutorial] = useState<TutorialPayload | null>(null)
    const [currentTutorialStep, setCurrentTutorialStep] = useState(0)
    const [isRestoring, setIsRestoring] = useState(true)
    const [storageKey, setStorageKey] = useState<string | null>(null)

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
            if (stored) {
                if (!stored.origin || stored.origin === window.location.origin) {
                    const savedTutorial = stored.tutorial ?? null
                    setTutorial(savedTutorial)
                    setCurrentTutorialStep(savedTutorial ? stored.currentTutorialStep ?? 0 : 0)
                    if (typeof stored.isOpen === 'boolean') {
                        setIsOpen(stored.isOpen)
                    }
                } else {
                    chrome.storage?.local?.remove([storageKey])
                }
            }
            setIsRestoring(false)
        })
    }, [storageKey])

    useEffect(() => {
        if (isRestoring || !storageKey) return

        // Check if chrome.storage is available
        if (!chrome?.storage?.local) {
            return
        }

        const state: StoredState = {
            tutorial,
            currentTutorialStep,
            isOpen,
            origin: window.location.origin
        }

        chrome.storage.local.set({ [storageKey]: state }, () => {
            if (chrome.runtime.lastError) {
                console.warn('Failed to save state:', chrome.runtime.lastError)
            }
        })
    }, [tutorial, currentTutorialStep, isOpen, storageKey, isRestoring])

    const exitTutorial = () => {
        setTutorial(null)
        setCurrentTutorialStep(0)
    }

    const handleTutorialComplete = () => {
        setTutorial(null)
        setCurrentTutorialStep(0)
    }

    const handleReset = () => {
        exitTutorial()
        setHighlights([])
        setInput('')
        setLoading(false)
    }

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

    const handleSend = async () => {
        if (!input.trim()) return

        const userMessage = input
        setInput('')
        setLoading(true)
        setHighlights([])
        exitTutorial()

        // Check if this is a "create a new repo" request - use hardcoded example
        if (isCreateRepoRequest(userMessage)) {
            setLoading(false)
            setTutorial(EXAMPLE_CREATE_REPO_TUTORIAL)
            setCurrentTutorialStep(0)
            return
        }

        try {
            const screenshotDataUrl = await new Promise<string>((resolve) => {
                chrome.runtime.sendMessage({ action: 'captureScreen' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error(chrome.runtime.lastError)
                        resolve('')
                    } else {
                        resolve(response?.dataUrl || '')
                    }
                })
            })

            const formData = new FormData()
            formData.append('message', userMessage)

            if (screenshotDataUrl) {
                const compressedBlob = await compressScreenshot(screenshotDataUrl)
                formData.append('screenshot', compressedBlob, 'screenshot.jpg')
            }

            try {
                const domTree = getSimplifiedDom(document)
                formData.append('dom', JSON.stringify(domTree))
            } catch (err) {
                console.warn('Site Tutor: unable to generate sanitized DOM', err)
            }

            const response = await fetch('http://localhost:8000/chat', {
                method: 'POST',
                body: formData
            })

            const data = await response.json()

            let newHighlights = data.highlights || []

            if (data.tutorial && data.tutorial.steps?.length) {
                setTutorial(data.tutorial)
                setCurrentTutorialStep(0)
                newHighlights = []
            } else {
                setTutorial(null)
                setCurrentTutorialStep(0)
            }

            setHighlights(newHighlights)
            if (newHighlights.length > 0) {
                console.log('Site Tutor: Received highlights:', newHighlights)
            } else {
                console.log('Site Tutor: No highlights in response')
            }
        } catch (error) {
            console.error('Error:', error)
            // Show error state - could add a simple error message UI here if needed
        } finally {
            setLoading(false)
        }
    }

    const overlayHighlights = useMemo(() => {
        if (tutorial) {
            return tutorial.steps.map(step => ({ selector: step.selector, explanation: step.instruction }))
        }
        return highlights
    }, [tutorial, highlights])

    return (
        <>
            <Overlay highlights={overlayHighlights} currentStepIndex={tutorial ? currentTutorialStep : undefined} />

            <div className="fixed bottom-6 right-6 z-[99999] font-sans">
                <AnimatePresence>
                    {isOpen && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 10 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="chat-container"
                            style={{ marginBottom: '16px' }}
                        >
                            <div className="chat-header">
                                <div className="chat-header-left">
                                    <div className="chat-avatar">
                                        <MessageCircle size={14} strokeWidth={2.5} />
                                    </div>
                                    <div className="chat-header-info">
                                        <span className="chat-title">Site Tutor</span>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <button
                                        onClick={handleReset}
                                        className="chat-close"
                                        aria-label="Reset tutorial"
                                        title="Reset tutorial"
                                    >
                                        <RotateCcw size={14} strokeWidth={2} />
                                    </button>
                                    <button
                                        onClick={() => setIsOpen(false)}
                                        className="chat-close"
                                        aria-label="Close"
                                    >
                                        <X size={16} strokeWidth={2} />
                                    </button>
                                </div>
                            </div>

                            <div className="chat-body">
                                {tutorial ? (
                                    <div className="tutorial-container">
                                        {!isRestoring && (
                                            <TutorialController
                                                tutorial={tutorial}
                                                onClose={exitTutorial}
                                                onComplete={handleTutorialComplete}
                                                onStepChange={setCurrentTutorialStep}
                                                initialStepIndex={currentTutorialStep}
                                            />
                                        )}
                                    </div>
                                ) : (
                                    <div className="loading-container">
                                        {loading ? (
                                            <div className="loading-content">
                                                <Loader2 className="loading-spinner" size={32} strokeWidth={2} />
                                                <p className="loading-text">Creating your tutorial...</p>
                                            </div>
                                        ) : (
                                            <p className="placeholder-text">Input your tutorial.</p>
                                        )}
                                    </div>
                                )}
                            </div>

                            {!tutorial && (
                                <div className="chat-input-area">
                                    <div className="chat-input-wrapper">
                                        <input
                                            type="text"
                                            value={input}
                                            onChange={(e) => setInput(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && !loading && handleSend()}
                                            placeholder="Message..."
                                            disabled={loading}
                                            className="chat-input"
                                            style={{ paddingTop: '4px' }}
                                        />
                                        <button
                                            onClick={handleSend}
                                            disabled={loading || !input.trim()}
                                            className="chat-action-btn chat-action-btn--send"
                                            aria-label="Send message"
                                        >
                                            <Send size={16} strokeWidth={2.5} />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {!isOpen && (
                        <motion.button
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.8, opacity: 0 }}
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                            transition={{ duration: 0.2 }}
                            onClick={() => setIsOpen(true)}
                            className="chat-fab"
                            aria-label="Open Site Tutor"
                        >
                            <MessageCircle size={18} strokeWidth={2} />
                        </motion.button>
                    )}
                </AnimatePresence>
            </div>
        </>
    )
}

export default Chatbot
