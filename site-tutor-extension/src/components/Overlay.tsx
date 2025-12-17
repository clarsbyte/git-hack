import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Highlight {
    selector: string
    explanation: string
}

interface OverlayProps {
    highlights: Highlight[]
}

// Helper function to find button-like elements when selectors fail
const findButtonLikeElements = (explanation: string): Element[] => {
    const buttons: Element[] = []
    const lowerExplanation = explanation.toLowerCase()
    
    // Check if this is about buttons
    if (lowerExplanation.includes('button') || lowerExplanation.includes('btn')) {
        // Find all actual button elements
        buttons.push(...Array.from(document.querySelectorAll('button')))
        
        // Find anchor tags that look like buttons (have button-like styling or text)
        const links = Array.from(document.querySelectorAll('a')).filter(a => {
            const text = a.textContent?.toLowerCase() || ''
            const classes = a.className?.toLowerCase() || ''
            const href = a.getAttribute('href') || ''
            // Check if it looks like a button (has button-related classes, or is a call-to-action)
            return classes.includes('button') || classes.includes('btn') || 
                   text.includes('click') || text.includes('submit') || 
                   text.includes('sign') || text.includes('login') ||
                   href.includes('action') || a.getAttribute('role') === 'button'
        })
        buttons.push(...links)
        
        // Find input elements that are buttons
        buttons.push(...Array.from(document.querySelectorAll('input[type="button"], input[type="submit"]')))
        
        // Find elements with role="button"
        buttons.push(...Array.from(document.querySelectorAll('[role="button"]')))
    }
    
    // Filter out hidden elements
    return buttons.filter(el => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && 
               style.display !== 'none' && 
               style.visibility !== 'hidden' &&
               style.opacity !== '0'
    })
}

const Overlay: React.FC<OverlayProps> = ({ highlights }) => {
    // Store expanded highlights with their rects
    const [expandedHighlights, setExpandedHighlights] = useState<Array<{ highlight: Highlight; rect: DOMRect }>>([])

    const updateRects = () => {
        // Expand highlights: if a selector matches multiple elements, create separate entries for each
        const newExpandedHighlights: Array<{ highlight: Highlight; rect: DOMRect }> = []
        
        highlights.forEach(h => {
            try {
                // Try to find elements matching this selector
                const matches = document.querySelectorAll(h.selector)
                
                if (matches.length > 0) {
                    // If selector matches multiple elements, create an entry for each
                    matches.forEach((el, idx) => {
                        const rect = el.getBoundingClientRect()
                        const style = window.getComputedStyle(el)
                        // Only include visible elements
                        if (rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0') {
                            newExpandedHighlights.push({
                                highlight: {
                                    ...h,
                                    explanation: matches.length > 1 ? `${h.explanation} (${idx + 1})` : h.explanation
                                },
                                rect
                            })
                        }
                    })
                } else {
                    // Selector didn't match, try fallback strategies
                    let el: Element | null = null
                    
                    // Try without pseudo-selectors
                    if (h.selector.includes(':') || h.selector.includes('::')) {
                        const simplifiedSelector = h.selector.split(/[:]/)[0]
                        const simplifiedMatches = document.querySelectorAll(simplifiedSelector)
                        if (simplifiedMatches.length > 0) {
                            el = simplifiedMatches[0]
                        }
                    }
                    
                    // Fallback: If selector fails and explanation mentions buttons, try to find actual buttons
                    if (!el && (h.explanation.toLowerCase().includes('button') || 
                               h.explanation.toLowerCase().includes('btn'))) {
                        const buttonElements = findButtonLikeElements(h.explanation)
                        if (buttonElements.length > 0) {
                            el = buttonElements[0]
                            console.log(`Site Tutor: Using fallback button finder for: ${h.explanation}`, {
                                foundElement: el,
                                totalButtonsFound: buttonElements.length
                            })
                        }
                    }
                    
                    if (el) {
                        const rect = el.getBoundingClientRect()
                        const style = window.getComputedStyle(el)
                        if (rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden') {
                            newExpandedHighlights.push({
                                highlight: h,
                                rect
                            })
                        }
                    } else {
                        console.warn(`Site Tutor: Could not find element for selector: ${h.selector}`, {
                            explanation: h.explanation,
                            selector: h.selector,
                            pageUrl: window.location.href
                        })
                    }
                }
            } catch (e) {
                console.error(`Site Tutor: Invalid selector ${h.selector}`, e)
            }
        })
        
        setExpandedHighlights(newExpandedHighlights)
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
                {expandedHighlights.map(({ highlight, rect }, i) => {
                    // If element is off-screen (scrolled away), maybe hide or just let it render off-screen
                    if (rect.width === 0 || rect.height === 0) return null

                    return (
                        <motion.div
                            key={`${i}-${highlight.selector}-${rect.top}-${rect.left}`}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className="absolute border-4 border-red-500 rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.5)] bg-red-500/10 box-border"
                            style={{
                                top: rect.top,
                                left: rect.left,
                                width: rect.width,
                                height: rect.height,
                            }}
                        >
                            <div className="absolute -top-10 left-0 bg-red-500 text-white font-bold px-3 py-1 rounded shadow-md whitespace-nowrap text-sm z-50 pointer-events-auto">
                                {highlight.explanation}
                            </div>
                        </motion.div>
                    )
                })}
            </AnimatePresence>
        </div>
    )
}

export default Overlay
