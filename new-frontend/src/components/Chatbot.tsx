import React, { useState, useRef, useEffect, useCallback } from 'react'
import { MessageCircle, X, Send, Sun, Moon, Sparkles, GripHorizontal } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Overlay from './Overlay'

interface Message {
    sender: 'user' | 'bot'
    text: string
    isWelcome?: boolean
}

interface Highlight {
    selector: string
    explanation: string
}

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [messages, setMessages] = useState<Message[]>([
        {
            sender: 'bot',
            text: "Hi! I'm Site Tutor. I can help you navigate and understand any website. What would you like to learn?",
            isWelcome: true
        }
    ])
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [highlights, setHighlights] = useState<Highlight[]>([])
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        if (typeof window !== 'undefined') {
            const savedTheme = localStorage.getItem('site-tutor-theme') as 'light' | 'dark' | null
            if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme
            return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
        }
        return 'light'
    })
    const [windowSize, setWindowSize] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('site-tutor-size')
            if (!saved) return { width: 380, height: 520 }
            try {
                return JSON.parse(saved)
            } catch {
                return { width: 380, height: 520 }
            }
        }
        return { width: 380, height: 520 }
    })
    const [isResizing, setIsResizing] = useState(false)

    const messagesEndRef = useRef<HTMLDivElement>(null)
    const chatWindowRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)

    useEffect(() => {
        localStorage.setItem('site-tutor-theme', theme)
    }, [theme])

    useEffect(() => {
        localStorage.setItem('site-tutor-size', JSON.stringify(windowSize))
    }, [windowSize])

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

    // Auto-resize textarea
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto'
            inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px'
        }
    }, [input])

    // Resize handlers
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        setIsResizing(true)
    }, [])

    useEffect(() => {
        if (!isResizing) return

        const handleMouseMove = (e: MouseEvent) => {
            if (!chatWindowRef.current) return
            const rect = chatWindowRef.current.getBoundingClientRect()
            const newWidth = Math.max(340, Math.min(640, e.clientX - rect.left))
            const newHeight = Math.max(420, Math.min(760, e.clientY - rect.top))
            setWindowSize({ width: newWidth, height: newHeight })
        }

        const handleMouseUp = () => setIsResizing(false)

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
        return () => {
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }
    }, [isResizing])

    const handleQuickAction = (action: string) => {
        setInput(action)
        setTimeout(() => handleSend(action), 50)
    }

    const handleSend = async (overrideMessage?: string) => {
        const messageToSend = overrideMessage || input
        if (!messageToSend.trim() || loading) return

        const userMessage = messageToSend.trim()
        setMessages(prev => [...prev, { sender: 'user', text: userMessage }])
        setInput('')
        setLoading(true)
        setHighlights([])

        try {
            const screenshotDataUrl = await new Promise<string>((resolve) => {
                chrome.runtime.sendMessage({ action: 'captureScreen' }, (response) => {
                    if (chrome.runtime.lastError) {
                        resolve('')
                    } else {
                        resolve(response?.dataUrl || '')
                    }
                })
            })

            const formData = new FormData()
            formData.append('message', userMessage)

            if (screenshotDataUrl) {
                const res = await fetch(screenshotDataUrl)
                const blob = await res.blob()
                formData.append('screenshot', blob, 'screenshot.png')
            }

            const response = await fetch('http://localhost:8000/chat', {
                method: 'POST',
                body: formData
            })

            const data = await response.json()
            setMessages(prev => [...prev, { sender: 'bot', text: data.text }])

            let newHighlights = data.highlights || []

            const userMessageLower = userMessage.toLowerCase()
            const isAllButtonsRequest = (userMessageLower.includes('all') || userMessageLower.includes('every') || userMessageLower.includes('highlight')) &&
                                       (userMessageLower.includes('button') || userMessageLower.includes('btn'))

            if (isAllButtonsRequest) {
                document.querySelectorAll('[data-site-tutor-id]').forEach(el => el.removeAttribute('data-site-tutor-id'))
                const allButtons: Highlight[] = []
                let buttonIndex = 0

                const isVisible = (el: Element): boolean => {
                    const rect = el.getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
                }

                const addButton = (el: Element, label: string) => {
                    if (isVisible(el) && !el.hasAttribute('data-site-tutor-id')) {
                        const id = `btn-${buttonIndex++}`
                        el.setAttribute('data-site-tutor-id', id)
                        allButtons.push({ selector: `[data-site-tutor-id="${id}"]`, explanation: label.substring(0, 30) || 'Button' })
                    }
                }

                document.querySelectorAll('button').forEach(btn => addButton(btn, btn.textContent?.trim() || 'Button'))
                document.querySelectorAll('[role="button"]').forEach(el => addButton(el, el.textContent?.trim() || 'Button'))
                document.querySelectorAll('input[type="button"], input[type="submit"]').forEach(input => addButton(input, (input as HTMLInputElement).value || 'Submit'))
                document.querySelectorAll('a').forEach(link => {
                    const classes = link.className?.toLowerCase() || ''
                    if (classes.includes('button') || classes.includes('btn') || link.getAttribute('role') === 'button') {
                        addButton(link, link.textContent?.trim() || 'Link Button')
                    }
                })

                if (allButtons.length > 0) newHighlights = allButtons
            }

            setHighlights(newHighlights)
        } catch {
            setMessages(prev => [...prev, { sender: 'bot', text: 'Sorry, I couldn\'t connect to the server. Please make sure the backend is running.' }])
        } finally {
            setLoading(false)
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    // Loading indicator
    const LoadingIndicator = () => (
        <div className="flex items-center gap-1.5 py-1">
            {[0, 1, 2].map(i => (
                <div
                    key={i}
                    className="loading-dot w-2 h-2 rounded-full"
                    style={{ backgroundColor: 'var(--text-tertiary)' }}
                />
            ))}
        </div>
    )

    // Message component
    const MessageRow = ({ msg }: { msg: Message }) => {
        const isBot = msg.sender === 'bot'

        return (
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className={isBot ? 'flex gap-3 items-start' : 'flex justify-end'}
            >
                {isBot && (
                    <div className="st-avatar st-avatar--bot mt-0.5">
                        <Sparkles size={16} />
                    </div>
                )}

                <div className={isBot ? 'st-bubble st-bubble--bot' : 'st-bubble st-bubble--user'}>
                    <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                        {msg.text}
                    </p>

                    {msg.isWelcome && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            <button
                                onClick={() => handleQuickAction('Navigate me through this page')}
                                className="st-chip px-3 py-1.5 text-sm font-medium rounded-full"
                            >
                                Navigate me
                            </button>
                            <button
                                onClick={() => handleQuickAction('Summarize this page')}
                                className="st-chip px-3 py-1.5 text-sm font-medium rounded-full"
                            >
                                Summarize page
                            </button>
                            <button
                                onClick={() => handleQuickAction('What can I do on this page?')}
                                className="st-chip px-3 py-1.5 text-sm font-medium rounded-full"
                            >
                                What can I do here?
                            </button>
                            <button
                                onClick={() => handleQuickAction('Highlight all buttons')}
                                className="st-chip px-3 py-1.5 text-sm font-medium rounded-full"
                            >
                                Highlight buttons
                            </button>
                        </div>
                    )}
                </div>
            </motion.div>
        )
    }

    return (
        <div data-theme={theme}>
            <Overlay highlights={highlights} />

            <div className="fixed bottom-5 right-5 z-[99999] font-sans antialiased">
                <AnimatePresence>
                    {isOpen && (
                        <motion.div
                            ref={chatWindowRef}
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                            className="st-window mb-4 overflow-hidden flex flex-col relative"
                            style={{
                                width: windowSize.width,
                                height: windowSize.height,
                            }}
                        >
                            {/* Header */}
                            <div className="st-header">
                                <div className="flex items-center justify-between px-4 pt-3 pb-2">
                                    <div className="flex items-center gap-3">
                                        <div className="st-avatar st-avatar--bot">
                                            <Sparkles size={18} />
                                        </div>
                                        <div>
                                            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                                Site Tutor
                                            </h2>
                                            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                                Your on-page guide
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
                                            className="st-icon-btn"
                                            aria-label="Toggle theme"
                                        >
                                            {theme === 'light' ? (
                                                <Moon size={18} style={{ color: 'var(--text-secondary)' }} />
                                            ) : (
                                                <Sun size={18} style={{ color: 'var(--text-secondary)' }} />
                                            )}
                                        </button>
                                        <button
                                            onClick={() => setIsOpen(false)}
                                            className="st-icon-btn"
                                            aria-label="Close"
                                        >
                                            <X size={18} style={{ color: 'var(--text-secondary)' }} />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Messages */}
                            <div
                                className="flex-1 overflow-y-auto custom-scrollbar"
                                style={{ background: 'var(--bg-secondary)' }}
                            >
                                <div className="px-4 py-4 space-y-4">
                                    {messages.map((msg, idx) => (
                                        <MessageRow key={idx} msg={msg} />
                                    ))}

                                    {loading && (
                                        <div className="flex gap-3 items-start">
                                            <div className="st-avatar st-avatar--bot mt-0.5">
                                                <Sparkles size={16} />
                                            </div>
                                            <div className="st-bubble st-bubble--bot">
                                                <LoadingIndicator />
                                            </div>
                                        </div>
                                    )}

                                    {highlights.length > 0 && !loading && (
                                        <div className="sticky bottom-2 flex justify-center pt-1">
                                            <span
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold"
                                                style={{
                                                    background: 'var(--accent-light)',
                                                    color: 'var(--text-primary)',
                                                    border: '1px solid var(--border-light)'
                                                }}
                                            >
                                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                                                {highlights.length} element{highlights.length !== 1 ? 's' : ''} highlighted
                                            </span>
                                        </div>
                                    )}

                                    <div ref={messagesEndRef} />
                                </div>
                            </div>

                            {/* Input Area */}
                            <div
                                className="st-composer p-3"
                            >
                                <div
                                    className="st-input-shell flex items-end gap-2 rounded-2xl px-3 py-2"
                                >
                                    <textarea
                                        ref={inputRef}
                                        value={input}
                                        onChange={(e) => setInput(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder="Ask Site Tutor…"
                                        rows={1}
                                        className="flex-1 bg-transparent outline-none resize-none text-[15px] py-1 leading-relaxed"
                                        style={{
                                            color: 'var(--text-primary)',
                                            maxHeight: '120px'
                                        }}
                                    />
                                    <button
                                        onClick={() => handleSend()}
                                        disabled={loading || !input.trim()}
                                        className="st-send-btn w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                                        aria-label="Send"
                                    >
                                        <Send size={16} />
                                    </button>
                                </div>
                                <p className="text-center text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
                                    Enter to send • Shift+Enter for a new line
                                </p>
                            </div>

                            {/* Resize Handle */}
                            <div
                                onMouseDown={handleResizeStart}
                                className="st-resize-handle absolute bottom-2 right-2 w-8 h-8 cursor-se-resize flex items-center justify-center"
                            >
                                <GripHorizontal size={14} className="rotate-[45deg]" />
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* FAB */}
                <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ duration: 0.15 }}
                    onClick={() => setIsOpen(!isOpen)}
                    className="st-fab flex h-14 w-14 items-center justify-center rounded-full transition-all duration-200 text-white"
                    aria-label={isOpen ? 'Close chat' : 'Open chat'}
                >
                    <AnimatePresence mode="wait">
                        {isOpen ? (
                            <motion.div
                                key="close"
                                initial={{ rotate: -90, opacity: 0 }}
                                animate={{ rotate: 0, opacity: 1 }}
                                exit={{ rotate: 90, opacity: 0 }}
                                transition={{ duration: 0.15 }}
                            >
                                <X size={24} />
                            </motion.div>
                        ) : (
                            <motion.div
                                key="open"
                                initial={{ rotate: 90, opacity: 0 }}
                                animate={{ rotate: 0, opacity: 1 }}
                                exit={{ rotate: -90, opacity: 0 }}
                                transition={{ duration: 0.15 }}
                            >
                                <MessageCircle size={24} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.button>
            </div>
        </div>
    )
}

export default Chatbot
