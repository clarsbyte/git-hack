import React, { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Overlay from './Overlay'

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

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [messages, setMessages] = useState<Message[]>([
        { sender: 'bot', text: "Hi! I'm your Site Tutor. I can teach you anything about this website. Click the camera icon or ask a question to get started!" }
    ])
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [highlights, setHighlights] = useState<Highlight[]>([])

    // Session and automation state
    const [sessionId, setSessionId] = useState<string | null>(null)
    const [automationStatus, setAutomationStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
    const [automationProgress, setAutomationProgress] = useState<string[]>([])
    const [luxEventSource, setLuxEventSource] = useState<EventSource | null>(null)

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

    const handleSend = async () => {
        if (!input.trim()) return

        const userMessage = input
        setMessages(prev => [...prev, { sender: 'user', text: userMessage }])
        setInput('')
        setLoading(true)
        setHighlights([]) // Clear previous highlights

        try {
            // 1. Capture Screenshot
            const screenshotDataUrl = await new Promise<string>((resolve) => {
                chrome.runtime.sendMessage({ action: 'captureScreen' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error(chrome.runtime.lastError)
                        resolve('') // Proceed without screenshot if fails
                    } else {
                        resolve(response?.dataUrl || '')
                    }
                })
            })

            // 2. Prepare Form Data
            const formData = new FormData()
            formData.append('message', userMessage)

            // Include session ID if we have one
            if (sessionId) {
                formData.append('sessionId', sessionId)
            }

            if (screenshotDataUrl) {
                // Convert data URL to blob
                const res = await fetch(screenshotDataUrl)
                const blob = await res.blob()
                formData.append('screenshot', blob, 'screenshot.png')
            }

            // 3. Call Backend
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
                        }
                    }, 1000)
                }
            }

            let newHighlights = data.highlights || []

            // Check if user is asking for button highlighting - always use direct DOM detection for reliability
            const userMessageLower = userMessage.toLowerCase()
            const isAllButtonsRequest = (userMessageLower.includes('all') || userMessageLower.includes('every') || userMessageLower.includes('highlight')) &&
                                       (userMessageLower.includes('button') || userMessageLower.includes('btn'))

            // For button requests, ALWAYS use direct DOM detection (backend selectors are unreliable)
            if (isAllButtonsRequest) {
                // Clear any previous highlight markers
                document.querySelectorAll('[data-site-tutor-id]').forEach(el => {
                    el.removeAttribute('data-site-tutor-id')
                })

                // Find all button-like elements on the page
                const allButtons: Highlight[] = []
                let buttonIndex = 0

                // Helper to check if element is visible
                const isVisible = (el: Element): boolean => {
                    const rect = el.getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0 &&
                           style.display !== 'none' &&
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0'
                }

                // Find actual button elements
                document.querySelectorAll('button').forEach((btn) => {
                    if (isVisible(btn)) {
                        const id = `btn-${buttonIndex++}`
                        btn.setAttribute('data-site-tutor-id', id)
                        const text = btn.textContent?.trim() || 'Button'
                        allButtons.push({
                            selector: `[data-site-tutor-id="${id}"]`,
                            explanation: text.substring(0, 30) || 'Button'
                        })
                    }
                })

                // Find elements with role="button"
                document.querySelectorAll('[role="button"]').forEach((el) => {
                    if (isVisible(el) && !el.hasAttribute('data-site-tutor-id')) {
                        const id = `btn-${buttonIndex++}`
                        el.setAttribute('data-site-tutor-id', id)
                        const text = el.textContent?.trim() || 'Button'
                        allButtons.push({
                            selector: `[data-site-tutor-id="${id}"]`,
                            explanation: text.substring(0, 30) || 'Button'
                        })
                    }
                })

                // Find input buttons
                document.querySelectorAll('input[type="button"], input[type="submit"]').forEach((input) => {
                    if (isVisible(input)) {
                        const id = `btn-${buttonIndex++}`
                        input.setAttribute('data-site-tutor-id', id)
                        const value = (input as HTMLInputElement).value || 'Submit'
                        allButtons.push({
                            selector: `[data-site-tutor-id="${id}"]`,
                            explanation: value.substring(0, 30) || 'Input Button'
                        })
                    }
                })

                // Find anchor tags that look like buttons (have button classes or role)
                document.querySelectorAll('a').forEach((link) => {
                    if (link.hasAttribute('data-site-tutor-id')) return
                    const classes = link.className?.toLowerCase() || ''
                    const role = link.getAttribute('role')
                    if (isVisible(link) && (classes.includes('button') || classes.includes('btn') || role === 'button')) {
                        const id = `btn-${buttonIndex++}`
                        link.setAttribute('data-site-tutor-id', id)
                        const text = link.textContent?.trim() || 'Link Button'
                        allButtons.push({
                            selector: `[data-site-tutor-id="${id}"]`,
                            explanation: text.substring(0, 30) || 'Link Button'
                        })
                    }
                })

                if (allButtons.length > 0) {
                    console.log(`Site Tutor: Found ${allButtons.length} buttons on the page`, allButtons)
                    newHighlights = allButtons
                } else {
                    console.log('Site Tutor: No buttons found on this page')
                }
            }
            
            setHighlights(newHighlights)
            
            // Log highlights for debugging
            if (newHighlights.length > 0) {
                console.log('Site Tutor: Received highlights:', newHighlights)
            } else {
                console.log('Site Tutor: No highlights in response')
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
            <Overlay highlights={highlights} />

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
                            {/* Header */}
                            <div className="flex items-center justify-between bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-4 text-white">
                                <h2 className="text-lg font-semibold tracking-wide">Site Tutor</h2>
                                <button
                                    onClick={() => setIsOpen(false)}
                                    className="rounded-full p-1 opacity-80 hover:bg-white/20 hover:opacity-100 transition-colors"
                                >
                                    <X size={20} />
                                </button>
                            </div>

                            {/* Messages */}
                            <div className="flex-1 overflow-y-auto p-4 bg-gray-50 flex flex-col gap-3">
                                {messages.map((msg, idx) => (
                                    <div
                                        key={idx}
                                        className={`max-w-[80%] p-3 rounded-2xl text-sm ${msg.sender === 'user' ? 'self-end bg-violet-600 text-white rounded-br-none' : 'self-start bg-white border border-gray-100 text-gray-600 rounded-tl-none shadow-sm'}`}
                                    >
                                        {msg.text}
                                    </div>
                                ))}
                                {loading && (
                                    <div className="self-start bg-white border border-gray-100 p-3 rounded-2xl rounded-tl-none shadow-sm text-sm text-gray-500">
                                        Thinking...
                                    </div>
                                )}
                                {automationStatus === 'running' && automationProgress.length > 0 && (
                                    <div className="self-start bg-blue-50 border border-blue-200 p-3 rounded-lg text-xs text-blue-800 max-w-[80%]">
                                        <div className="font-bold mb-1">🤖 Automation Progress:</div>
                                        {automationProgress.slice(-3).map((progress, idx) => (
                                            <div key={idx} className="text-xs">{progress}</div>
                                        ))}
                                    </div>
                                )}
                                {highlights.length > 0 && !loading && (
                                    <div className="self-start bg-red-50 border border-red-200 p-2 rounded-lg text-xs text-red-800">
                                        ✨ Highlighting {highlights.length} element{highlights.length !== 1 ? 's' : ''} on the page
                                    </div>
                                )}
                                <div ref={messagesEndRef} />
                            </div>

                            {/* Input Area */}
                            <div className="p-4 border-t border-gray-100 bg-white">
                                <div className="relative flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={input}
                                        onChange={(e) => setInput(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                                        placeholder="Ask about this page..."
                                        className="flex-1 rounded-xl bg-gray-100 px-4 py-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-all shadow-inner"
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
