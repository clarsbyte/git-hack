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

const Chatbot: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false)
    const [messages, setMessages] = useState<Message[]>([
        { sender: 'bot', text: "Hi! I'm your Site Tutor. I can teach you anything about this website. Click the camera icon or ask a question to get started!" }
    ])
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [highlights, setHighlights] = useState<Highlight[]>([])

    const messagesEndRef = useRef<HTMLDivElement>(null)

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

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

            setMessages(prev => [...prev, { sender: 'bot', text: data.text }])
            setHighlights(data.highlights || [])

        } catch (error) {
            console.error('Error:', error)
            setMessages(prev => [...prev, { sender: 'bot', text: 'Sorry, I encountered an error connecting to the brain.' }])
        } finally {
            setLoading(false)
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
