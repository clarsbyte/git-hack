import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageCircle, Send, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import Overlay from './Overlay'
import TutorialController from './TutorialController'
import type { TutorialPayload } from '../types/tutorial'
import { getSimplifiedDom } from '../utils/domSanitizer'
import { VERSION } from '../version'

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

            <div className="fixed bottom-6 right-6 z-[99999] font-sans text-gray-800 antialiased">
                <AnimatePresence>
                    {isOpen && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, y: 20 }}
                            className="mb-4 w-96 rounded-2xl bg-white shadow-2xl ring-1 ring-black/5 flex flex-col overflow-hidden"
                            style={{ height: '500px' }}
                        >
                            <div className="flex items-center justify-between bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-4 text-white">
                                <div className="flex flex-col">
                                    <h2 className="text-lg font-semibold tracking-wide">Site Tutor</h2>
                                    <span className="text-xs opacity-75 font-normal">v{VERSION}</span>
                                </div>
                                <button
                                    onClick={() => setIsOpen(false)}
                                    className="rounded-full p-1 opacity-80 hover:bg-white/20 hover:opacity-100 transition-colors"
                                >
                                    <X size={20} />
                                </button>
                            </div>

                            <div className="flex-1 overflow-hidden p-4 bg-gray-50 flex flex-col gap-3">
                                {tutorial ? (
                                    <div className="flex-1 overflow-y-auto rounded-2xl border border-violet-100 bg-white p-4 shadow-inner">
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
                                    <div className="flex-1 flex items-center justify-center">
                                        <div className="text-center">
                                            {loading ? (
                                                <div className="flex flex-col items-center gap-3">
                                                    <Loader2 className="h-8 w-8 text-violet-600 animate-spin" />
                                                    <p className="text-gray-500 text-sm">Creating your tutorial...</p>
                                                </div>
                                            ) : (
                                                <p className="text-gray-500 text-sm">Input your tutorial.</p>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {!tutorial && (
                                <div className="p-4 border-t border-gray-100 bg-white">
                                    <div className="relative flex items-center gap-2">
                                        <input
                                            type="text"
                                            value={input}
                                            onChange={(e) => setInput(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && !loading && handleSend()}
                                            placeholder="Input your tutorial."
                                            disabled={loading}
                                            className="flex-1 rounded-xl bg-gray-100 px-4 py-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-all shadow-inner disabled:opacity-50"
                                        />
                                        <button
                                            onClick={handleSend}
                                            disabled={loading || !input.trim()}
                                            className="rounded-lg bg-violet-600 p-3 text-white hover:bg-violet-700 transition-colors shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Send size={16} />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-xl hover:shadow-2xl hover:shadow-violet-500/30 transition-shadow"
                >
                    {isOpen ? <X size={24} /> : <MessageCircle size={28} />}
                </motion.button>
            </div>
        </>
    )
}

export default Chatbot
