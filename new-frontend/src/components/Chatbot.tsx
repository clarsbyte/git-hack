import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Mic, ArrowUp, X, MessageSquare, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Overlay from './Overlay'

interface Message {
    id: string
    sender: 'user' | 'bot'
    text: string
}

interface Highlight {
    selector: string
    explanation: string
}

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [messages, setMessages] = useState<Message[]>([
        { id: '1', sender: 'bot', text: 'How can I help you?' }
    ])
    const [highlights, setHighlights] = useState<Highlight[]>([])
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [isRecording, setIsRecording] = useState(false)
    const [isFocused, setIsFocused] = useState(false)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const audioChunksRef = useRef<Blob[]>([])

    const hasInput = input.trim().length > 0

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages, loading])

    // Focus input when opened
    useEffect(() => {
        if (isOpen && inputRef.current) {
            setTimeout(() => inputRef.current?.focus(), 100)
        }
    }, [isOpen])

    // Auto-resize textarea
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto'
            inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px'
        }
    }, [input])

    // Keyboard shortcut: Escape to close
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                setIsOpen(false)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isOpen])

    const generateId = () => Math.random().toString(36).substring(2, 9)

    const handleReset = () => {
        setMessages([{ id: generateId(), sender: 'bot', text: 'How can I help you?' }])
        setHighlights([])
        setInput('')
    }

    const handleSend = useCallback(async () => {
        if (!input.trim() || loading) return
        const userMessage = input.trim()
        const userMsgId = generateId()

        setMessages(prev => [...prev, { id: userMsgId, sender: 'user', text: userMessage }])
        setInput('')
        setLoading(true)

        // Reset textarea height
        if (inputRef.current) {
            inputRef.current.style.height = 'auto'
        }

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
            setMessages(prev => [...prev, { id: generateId(), sender: 'bot', text: data.text || 'Done.' }])
            
            // Set highlights if present
            if (data.highlights && data.highlights.length > 0) {
                setHighlights(data.highlights)
            }
            
        } catch {
            setMessages(prev => [...prev, { id: generateId(), sender: 'bot', text: 'Unable to connect to server.' }])
        } finally {
            setLoading(false)
        }
    }, [input, loading])

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            const mediaRecorder = new MediaRecorder(stream)
            mediaRecorderRef.current = mediaRecorder
            audioChunksRef.current = []

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data)
                }
            }

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
                const formData = new FormData()
                formData.append('audio', audioBlob, 'voice.webm')

                setIsRecording(false) // Stop visual pulse
                setInput('Transcribing...') // Visual feedback in input
                
                try {
                    const response = await fetch('http://localhost:8000/transcribe', {
                        method: 'POST',
                        body: formData
                    })
                    
                    if (!response.ok) throw new Error('Transcription failed')
                    
                    const data = await response.json()
                    setInput(data.text)
                    
                    // Auto-focus back to input
                    setTimeout(() => inputRef.current?.focus(), 100)
                    
                } catch (error) {
                    console.error("Transcription error:", error)
                    setInput('')
                    setMessages(prev => [...prev, { id: generateId(), sender: 'bot', text: 'Sorry, I could not transcribe your voice.' }])
                }
                
                // Stop all tracks
                stream.getTracks().forEach(track => track.stop())
            }

            mediaRecorder.start()
            setIsRecording(true)
        } catch (error) {
            console.error("Error accessing microphone:", error)
            setMessages(prev => [...prev, { id: generateId(), sender: 'bot', text: 'Microphone access denied or not available.' }])
        }
    }

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop()
            // isRecording sets to false in onstop handler
        }
    }

    const handleVoice = () => {
        if (isRecording) {
            stopRecording()
        } else {
            startRecording()
        }
    }

    const suggestions = [
        'Explain this page',
        'Find the main CTA',
        'Summarize content'
    ]

    return (
        <>
            <Overlay highlights={highlights} />
            
            {/* Floating Action Button */}
            <AnimatePresence>
                {!isOpen && (
                    <motion.button
                        type="button"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        transition={{ duration: 0.2 }}
                        onClick={() => setIsOpen(true)}
                        className="chat-fab"
                        aria-label="Open assistant"
                    >
                        <MessageSquare size={18} strokeWidth={2} />
                    </motion.button>
                )}
            </AnimatePresence>

            {/* Chat Window */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="chat-container"
                    >
                        {/* Header */}
                        <div className="chat-header">
                            <div className="chat-header-left">
                                <div className="chat-avatar">
                                    <MessageSquare size={14} strokeWidth={2.5} />
                                </div>
                                <div className="chat-header-info">
                                    <span className="chat-title">Chat</span>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <button
                                    type="button"
                                    onClick={handleReset}
                                    className="chat-close"
                                    aria-label="Reset"
                                    title="Reset chat and highlights"
                                >
                                    <RotateCcw size={14} strokeWidth={2} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsOpen(false)}
                                    className="chat-close"
                                    aria-label="Close"
                                >
                                    <X size={16} strokeWidth={2} />
                                </button>
                            </div>
                        </div>

                        {/* Messages */}
                        <div className="chat-messages">
                            {messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`chat-msg-row ${msg.sender === 'user' ? 'chat-msg-row--user' : ''}`}
                                >
                                    {msg.sender === 'bot' && (
                                        <div className="chat-msg-avatar">
                                            <MessageSquare size={12} strokeWidth={2.5} />
                                        </div>
                                    )}
                                    <div className={`chat-msg ${msg.sender === 'user' ? 'chat-msg--user' : 'chat-msg--bot'}`}>
                                        {msg.text}
                                    </div>
                                </div>
                            ))}

                            {/* Loading indicator */}
                            {loading && (
                                <div className="chat-msg-row">
                                    <div className="chat-msg-avatar">
                                        <MessageSquare size={12} strokeWidth={2.5} />
                                    </div>
                                    <div className="chat-msg chat-msg--bot">
                                        <div className="chat-typing">
                                            <span></span>
                                            <span></span>
                                            <span></span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Suggestions (show only if few messages) */}
                            {messages.length <= 1 && !loading && (
                                <div className="chat-suggestions">
                                    {suggestions.map((s, i) => (
                                        <button
                                            key={i}
                                            type="button"
                                            onClick={() => {
                                                setInput(s)
                                                inputRef.current?.focus()
                                            }}
                                            className="chat-suggestion"
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input Area */}
                        <div className="chat-input-area">
                            <div className={`chat-input-wrapper ${isFocused ? 'chat-input-wrapper--focused' : ''}`}>
                                <textarea
                                    ref={inputRef}
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    onFocus={() => setIsFocused(true)}
                                    onBlur={() => setIsFocused(false)}
                                    placeholder="Message..."
                                    className="chat-input"
                                    disabled={loading}
                                    rows={1}
                                />
                                <button
                                    type="button"
                                    onClick={hasInput ? handleSend : handleVoice}
                                    disabled={loading && hasInput}
                                    className={`chat-action-btn ${hasInput ? 'chat-action-btn--send' : ''} ${isRecording ? 'chat-action-btn--recording' : ''}`}
                                    aria-label={hasInput ? 'Send message' : 'Voice input'}
                                >
                                    {hasInput ? (
                                        <ArrowUp size={16} strokeWidth={2.5} />
                                    ) : (
                                        <Mic size={16} strokeWidth={2} />
                                    )}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    )
}

export default Chatbot
