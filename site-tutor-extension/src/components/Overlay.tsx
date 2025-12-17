import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Highlight {
    selector: string
    explanation: string
}

interface OverlayProps {
    highlights: Highlight[]
}

const Overlay: React.FC<OverlayProps> = ({ highlights }) => {
    // Store rects in state to trigger re-renders on scroll/resize
    const [rects, setRects] = useState<(DOMRect | null)[]>([])

    const updateRects = () => {
        const newRects = highlights.map(h => {
            try {
                const el = document.querySelector(h.selector)
                if (!el) {
                    console.warn(`Site Tutor: Could not find element for selector: ${h.selector}`)
                    return null
                }
                return el.getBoundingClientRect()
            } catch (e) {
                console.error(`Site Tutor: Invalid selector ${h.selector}`, e)
                return null
            }
        })
        setRects(newRects)
    }

    // Initial calculation and listeners
    useEffect(() => {
        updateRects()

        const handleResize = () => updateRects()
        const handleScroll = () => updateRects()

        window.addEventListener('resize', handleResize)
        window.addEventListener('scroll', handleScroll, { capture: true, passive: true })

        // MutationObserver to handle dynamic content changes?
        const observer = new MutationObserver(updateRects)
        observer.observe(document.body, { childList: true, subtree: true })

        return () => {
            window.removeEventListener('resize', handleResize)
            window.removeEventListener('scroll', handleScroll)
            observer.disconnect()
        }
    }, [highlights])

    return (
        <div className="fixed inset-0 pointer-events-none z-[99998] overflow-hidden">
            <AnimatePresence>
                {highlights.map((h, i) => {
                    const rect = rects[i]
                    if (!rect) return null

                    // If element is off-screen (scrolled away), maybe hide or just let it render off-screen
                    if (rect.width === 0 || rect.height === 0) return null

                    return (
                        <motion.div
                            key={`${i}-${h.selector}`}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className="absolute border-4 border-yellow-400 rounded-lg shadow-[0_0_15px_rgba(250,204,21,0.5)] bg-yellow-400/10 box-border"
                            style={{
                                top: rect.top,
                                left: rect.left,
                                width: rect.width,
                                height: rect.height,
                            }}
                        >
                            <div className="absolute -top-10 left-0 bg-yellow-400 text-black font-bold px-3 py-1 rounded shadow-md whitespace-nowrap text-sm z-50 pointer-events-auto">
                                {h.explanation}
                            </div>
                        </motion.div>
                    )
                })}
            </AnimatePresence>
        </div>
    )
}

export default Overlay
