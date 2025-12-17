import React, { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Highlight {
    selector: string
    explanation: string
}

interface OverlayProps {
    highlights: Highlight[]
    currentStepIndex?: number
}

const findButtonLikeElements = (explanation: string): Element[] => {
    const buttons: Element[] = []
    const lowerExplanation = explanation.toLowerCase()

    if (lowerExplanation.includes('button') || lowerExplanation.includes('btn')) {
        buttons.push(...Array.from(document.querySelectorAll('button')))

        const links = Array.from(document.querySelectorAll('a')).filter(a => {
            const text = a.textContent?.toLowerCase() || ''
            const classes = a.className?.toLowerCase() || ''
            const href = a.getAttribute('href') || ''
            return classes.includes('button') || classes.includes('btn') ||
                text.includes('click') || text.includes('submit') ||
                text.includes('sign') || text.includes('login') ||
                href.includes('action') || a.getAttribute('role') === 'button'
        })
        buttons.push(...links)

        buttons.push(...Array.from(document.querySelectorAll('input[type="button"], input[type="submit"]')))
        buttons.push(...Array.from(document.querySelectorAll('[role="button"]')))
    }

    return buttons.filter(el => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
    })
}

// Find elements by analyzing the explanation text - works for any element type
const findElementByExplanation = (explanation: string, selector: string): Element | null => {
    const lowerExplanation = explanation.toLowerCase()

    // Extract key terms from the explanation
    const keywords: string[] = []
    const strongKeywords: string[] = [] // High-priority keywords

    // Look for quoted text (likely field names or button labels)
    const quotedMatches = explanation.match(/['"]([^'"]+)['"]/g)
    if (quotedMatches) {
        strongKeywords.push(...quotedMatches.map(m => m.replace(/['"]/g, '').toLowerCase()))
    }

    // Common field name patterns
    if (lowerExplanation.includes('repository name')) {
        strongKeywords.push('repository name')
        keywords.push('repository', 'name', 'repo')
    }
    if (lowerExplanation.includes('description') || lowerExplanation.includes('desc')) {
        strongKeywords.push('description', 'desc')
        keywords.push('description', 'desc', 'about', 'summary')
    }
    if (lowerExplanation.includes('readme')) {
        strongKeywords.push('readme')
        keywords.push('initialize', 'init')
    }
    if (lowerExplanation.includes('public') || lowerExplanation.includes('private')) {
        strongKeywords.push('public', 'private')
        keywords.push('visibility')
    }

    console.log('Site Tutor: Searching for element with keywords:', { strongKeywords, keywords })

    // Determine what type of element we're looking for
    const isCheckbox = lowerExplanation.includes('check') || selector.includes('checkbox') || selector.includes('input#')
    const isButton = lowerExplanation.includes('button') || lowerExplanation.includes('click')
    const isInput = lowerExplanation.includes('input') || lowerExplanation.includes('enter') || lowerExplanation.includes('field')

    // Find all potentially relevant elements
    const allElements: Element[] = []

    if (isCheckbox || isInput) {
        allElements.push(...Array.from(document.querySelectorAll('input, textarea, select')))
        // Modern UIs use toggle switches (buttons with aria-pressed) instead of checkboxes
        allElements.push(...Array.from(document.querySelectorAll('button[aria-pressed], [role="switch"]')))
    }
    if (isButton) {
        allElements.push(...Array.from(document.querySelectorAll('button, [role="button"], a.btn, a.button')))
    }
    if (!isCheckbox && !isButton && !isInput) {
        // If unclear, search everything including toggle switches
        allElements.push(...Array.from(document.querySelectorAll('input, textarea, select, button, [role="button"], [role="switch"], [aria-pressed]')))
    }

    // Score each element based on how well it matches
    const scoredElements = allElements.map(element => {
        let score = 0

        const name = element.getAttribute('name')?.toLowerCase() || ''
        const id = element.getAttribute('id')?.toLowerCase() || ''
        const placeholder = element.getAttribute('placeholder')?.toLowerCase() || ''
        const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || ''
        const ariaLabelledBy = element.getAttribute('aria-labelledby') || ''
        const type = element.getAttribute('type')?.toLowerCase() || ''
        const value = element.getAttribute('value')?.toLowerCase() || ''
        const elementText = element.textContent?.toLowerCase() || ''

        // Find associated label or nearby text
        let labelText = ''
        let nearbyText = ''
        let referencedLabelText = ''

        if (id) {
            const label = document.querySelector(`label[for="${id}"]`)
            labelText = label?.textContent?.toLowerCase() || ''
        }
        if (!labelText && element.parentElement?.tagName === 'LABEL') {
            labelText = element.parentElement.textContent?.toLowerCase() || ''
        }
        if (ariaLabelledBy) {
            // aria-labelledby can reference multiple IDs separated by spaces
            const labelIds = ariaLabelledBy.split(/\s+/)
            labelIds.forEach(labelId => {
                const labelEl = document.getElementById(labelId)
                if (labelEl) {
                    referencedLabelText += ' ' + (labelEl.textContent?.toLowerCase() || '')
                }
            })
            labelText = labelText || referencedLabelText
        }

        // Check siblings and parent text for context
        const parent = element.parentElement
        if (parent) {
            const siblings = Array.from(parent.children)
            nearbyText = siblings.map(s => s.textContent?.toLowerCase() || '').join(' ')
        }

        const searchText = `${name} ${id} ${placeholder} ${ariaLabel} ${labelText} ${elementText} ${value}`.toLowerCase()
        const contextText = `${searchText} ${nearbyText}`.toLowerCase()

        // Score based on strong keyword matches (quoted text)
        strongKeywords.forEach(keyword => {
            if (elementText.includes(keyword)) score += 50 // Visible text is very strong signal
            if (referencedLabelText.includes(keyword)) score += 45 // ARIA-labelledby is also very strong
            if (labelText.includes(keyword)) score += 40
            if (ariaLabel.includes(keyword)) score += 30
            if (value.includes(keyword)) score += 25
            if (id.includes(keyword)) score += 20
            // Name attribute matching is very important for form fields
            if (name.includes(keyword)) score += 30
            // Also check if name contains variations (e.g., "repository[description]" contains "description")
            if (name.includes('description') || name.includes('desc')) {
                if (keyword === 'description' || keyword === 'desc') score += 25
            }
            if (nearbyText.includes(keyword)) score += 15
        })

        // Score based on regular keywords
        keywords.forEach(keyword => {
            if (searchText.includes(keyword)) score += 10
            if (name.includes(keyword)) score += 5
            if (id.includes(keyword)) score += 5
            if (labelText.includes(keyword)) score += 5
        })

        // Bonus for matching expected element type
        if (isCheckbox && type === 'checkbox') score += 20
        if (isButton && element.tagName === 'BUTTON') score += 20

        // If original selector had specific attributes, try to match them
        if (selector.includes('type=') && type) {
            const typeMatch = selector.match(/type=["']?([^"'\]]+)/)
            if (typeMatch && type === typeMatch[1]) score += 15
        }

        // Visibility check
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        const isVisible = rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'

        if (!isVisible) score = 0

        return { element, score, searchText, contextText }
    })

    // Sort by score and get the best match
    scoredElements.sort((a, b) => b.score - a.score)

    if (scoredElements.length > 0 && scoredElements[0].score > 0) {
        console.log('Site Tutor: Found element by explanation', {
            element: scoredElements[0].element,
            score: scoredElements[0].score,
            tagName: scoredElements[0].element.tagName,
            id: scoredElements[0].element.id,
            text: scoredElements[0].element.textContent?.substring(0, 50)
        })
        return scoredElements[0].element
    }

    // Last resort: search for label elements containing keywords, then find associated controls
    console.log('Site Tutor: No direct match, searching for label elements with keywords')
    const allLabels = Array.from(document.querySelectorAll('label, [id], span, div'))
    for (const label of allLabels) {
        const labelContent = label.textContent?.toLowerCase() || ''
        const labelId = label.id

        // Check if this label contains strong keywords
        const hasStrongMatch = strongKeywords.some(kw => labelContent.includes(kw))
        if (!hasStrongMatch) continue

        console.log('Site Tutor: Found label containing keywords', { labelId, labelContent: labelContent.substring(0, 50) })

        // Try to find associated control
        if (labelId) {
            // Look for elements with aria-labelledby pointing to this label
            const associatedControl = document.querySelector(`[aria-labelledby="${labelId}"], [aria-labelledby*="${labelId} "], [aria-labelledby*=" ${labelId}"]`)
            if (associatedControl) {
                const rect = associatedControl.getBoundingClientRect()
                const style = window.getComputedStyle(associatedControl)
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none') {
                    console.log('Site Tutor: Found associated control via aria-labelledby', { element: associatedControl })
                    return associatedControl
                }
            }
        }

        // If label is a <label> element, check for associated input
        if (label.tagName === 'LABEL') {
            const forAttr = label.getAttribute('for')
            if (forAttr) {
                const associatedInput = document.getElementById(forAttr)
                if (associatedInput) {
                    const rect = associatedInput.getBoundingClientRect()
                    const style = window.getComputedStyle(associatedInput)
                    if (rect.width > 0 && rect.height > 0 && style.display !== 'none') {
                        console.log('Site Tutor: Found associated input via label[for]', { element: associatedInput })
                        return associatedInput
                    }
                }
            }
        }
    }

    // Final fallback: find any visible container that contains the keywords in its text
    console.log('Site Tutor: No control found, searching for container with keyword text')
    const allContainers = Array.from(document.querySelectorAll('div, section, fieldset, form, li, article'))

    const scoredContainers = allContainers.map(container => {
        const containerText = container.textContent?.toLowerCase() || ''
        let score = 0

        // Check for strong keyword matches
        strongKeywords.forEach(kw => {
            if (containerText.includes(kw)) score += 20
        })

        // Check for regular keyword matches
        keywords.forEach(kw => {
            if (containerText.includes(kw)) score += 5
        })

        // Penalize very large containers (likely too generic)
        const textLength = containerText.length
        if (textLength > 1000) score = Math.max(0, score - 10)
        if (textLength > 5000) score = 0

        // Penalize containers that contain too many other containers (too generic)
        const childContainers = container.querySelectorAll('div, section').length
        if (childContainers > 20) score = Math.max(0, score - 10)
        if (childContainers > 50) score = 0

        // Bonus for smaller, more focused containers
        if (textLength < 200 && score > 0) score += 5

        // Visibility check
        const rect = container.getBoundingClientRect()
        const style = window.getComputedStyle(container)
        const isVisible = rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'

        if (!isVisible) score = 0

        return { container, score, textLength, childContainers }
    })

    // Sort by score
    scoredContainers.sort((a, b) => b.score - a.score)

    if (scoredContainers.length > 0 && scoredContainers[0].score > 0) {
        console.log('Site Tutor: Found relevant container as fallback', {
            element: scoredContainers[0].container,
            score: scoredContainers[0].score,
            textLength: scoredContainers[0].textLength,
            childContainers: scoredContainers[0].childContainers,
            text: scoredContainers[0].container.textContent?.substring(0, 100)
        })
        return scoredContainers[0].container
    }

    console.log('Site Tutor: No element found for explanation', { explanation, selector })
    return null
}

// Check if element is a form input that should highlight its container
const isFormInput = (el: Element): boolean => {
    const tagName = el.tagName.toLowerCase()
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select'
}

// Check if element is a button or heading that should be highlighted directly
const shouldHighlightDirectly = (el: Element): boolean => {
    const tagName = el.tagName.toLowerCase()
    const role = el.getAttribute('role')
    const classes = el.className?.toLowerCase() || ''
    const ariaPressed = el.getAttribute('aria-pressed')

    return tagName === 'button' ||
           tagName.match(/^h[1-6]$/) !== null ||
           role === 'button' ||
           role === 'switch' ||
           ariaPressed !== null || // Toggle switches have aria-pressed
           classes.includes('btn') ||
           classes.includes('button') ||
           classes.includes('switch') ||
           (tagName === 'input' && (el as HTMLInputElement).type === 'button') ||
           (tagName === 'input' && (el as HTMLInputElement).type === 'submit') ||
           (tagName === 'a' && (classes.includes('btn') || classes.includes('button')))
}

// Find the best container element to highlight for form inputs
const findContainerElement = (el: Element): Element => {
    const tagName = el.tagName.toLowerCase()
    const ariaPressed = el.getAttribute('aria-pressed')
    const role = el.getAttribute('role')

    // Toggle switches (buttons with aria-pressed or role=switch) should show their labeled container
    if ((tagName === 'button' && ariaPressed !== null) || role === 'switch') {
        const ariaLabelledBy = el.getAttribute('aria-labelledby')
        if (ariaLabelledBy) {
            // Find a parent container that includes both the button and its label
            let current = el.parentElement
            let depth = 0
            while (current && depth < 5) {
                const labelIds = ariaLabelledBy.split(/\s+/)
                const hasReferencedLabel = labelIds.some(id => current?.querySelector(`#${id}`) !== null)
                if (hasReferencedLabel) {
                    return current // This container includes both toggle and label
                }
                current = current.parentElement
                depth++
            }
        }
        // If we can't find a good container, just highlight the button
        return el
    }

    // Don't look for containers for regular buttons and headings
    if (shouldHighlightDirectly(el)) {
        return el
    }

    // For form inputs, try to find a meaningful container
    if (!isFormInput(el)) {
        return el
    }

    // Special case for checkboxes: look for parent label or nearby descriptive text
    if (tagName === 'input' && (el as HTMLInputElement).type === 'checkbox') {
        const parent = el.parentElement
        if (parent?.tagName === 'LABEL') {
            return parent // Highlight the whole label for checkboxes
        }
        // Look for a wrapper that contains both checkbox and label
        let current = el.parentElement
        let depth = 0
        while (current && depth < 3) {
            const hasLabel = current.querySelector('label') !== null
            const hasText = current.textContent && current.textContent.trim().length > 2
            if (hasLabel || hasText) {
                return current
            }
            current = current.parentElement
            depth++
        }
    }

    let current: Element | null = el
    let candidate = el
    let depth = 0
    const maxDepth = 5 // Don't go too far up the DOM tree

    while (current && depth < maxDepth) {
        current = current.parentElement
        depth++

        if (!current) break

        const rect = current.getBoundingClientRect()
        const style = window.getComputedStyle(current)

        // Check if this is a good container candidate
        const isVisible = rect.width > 0 && rect.height > 0 &&
                         style.display !== 'none' &&
                         style.visibility !== 'hidden'

        if (!isVisible) continue

        const tagName = current.tagName.toLowerCase()
        const classes = current.className?.toLowerCase() || ''

        // Look for common form field container patterns
        const isFormGroup = classes.includes('form-group') ||
                           classes.includes('field') ||
                           classes.includes('input-group') ||
                           classes.includes('control') ||
                           classes.includes('form-control') ||
                           tagName === 'label' ||
                           tagName === 'fieldset'

        // Check if container has a label as child (good indicator of form field)
        const hasLabel = current.querySelector('label') !== null

        // Update candidate if this looks like a form container
        if (isFormGroup || hasLabel) {
            candidate = current
        }

        // Stop if we hit certain boundaries
        if (tagName === 'form' || tagName === 'body' || classes.includes('modal') || classes.includes('dialog')) {
            break
        }

        // Don't use containers that are too big (likely not specific to this input)
        const inputRect = el.getBoundingClientRect()
        if (rect.height > inputRect.height * 8) {
            break
        }
    }

    return candidate
}

const Overlay: React.FC<OverlayProps> = ({ highlights, currentStepIndex }) => {
    const [expandedHighlights, setExpandedHighlights] = useState<Array<{ highlight: Highlight; rect: DOMRect }>>([])

    const updateRects = useCallback(() => {
        const newExpandedHighlights: Array<{ highlight: Highlight; rect: DOMRect }> = []

        const relevantHighlights = typeof currentStepIndex === 'number'
            ? highlights[currentStepIndex]
                ? [highlights[currentStepIndex]]
                : []
            : highlights

        relevantHighlights.forEach(h => {
            try {
                let matches = document.querySelectorAll(h.selector)

                // If no matches, try alternative selector variations
                if (matches.length === 0) {
                    // Try escaping square brackets in attribute values
                    if (h.selector.includes('name=') && h.selector.includes('[')) {
                        // Try with escaped brackets: repository\[description\]
                        const escapedSelector = h.selector.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
                        try {
                            matches = document.querySelectorAll(escapedSelector)
                            if (matches.length > 0) {
                                console.log(`Site Tutor: Found element with escaped selector: ${escapedSelector}`)
                            }
                        } catch (e) {
                            // Escaped selector didn't work, continue to other fallbacks
                        }
                    }

                    // Try alternative attribute selector formats
                    if (matches.length === 0 && h.selector.includes('name=')) {
                        // Extract the name value and try different formats
                        const nameMatch = h.selector.match(/name=["']([^"']+)["']/)
                        if (nameMatch) {
                            const nameValue = nameMatch[1]
                            // Try without brackets: repository_description
                            const altName1 = nameValue.replace(/\[/g, '_').replace(/\]/g, '')
                            // Try with underscores: repository_description
                            const altSelector1 = h.selector.replace(nameValue, altName1)
                            try {
                                matches = document.querySelectorAll(altSelector1)
                                if (matches.length > 0) {
                                    console.log(`Site Tutor: Found element with alternative selector: ${altSelector1}`)
                                }
                            } catch (e) {
                                // Continue
                            }

                            // Try with hyphen: repository-description
                            if (matches.length === 0) {
                                const altName2 = nameValue.replace(/\[/g, '-').replace(/\]/g, '')
                                const altSelector2 = h.selector.replace(nameValue, altName2)
                                try {
                                    matches = document.querySelectorAll(altSelector2)
                                    if (matches.length > 0) {
                                        console.log(`Site Tutor: Found element with alternative selector: ${altSelector2}`)
                                    }
                                } catch (e) {
                                    // Continue
                                }
                            }
                        }
                    }
                }

                if (matches.length > 0) {
                    matches.forEach((el, idx) => {
                        // Find the best element to highlight (container for inputs, element itself for buttons/headings)
                        const targetElement = findContainerElement(el)
                        const rect = targetElement.getBoundingClientRect()
                        const style = window.getComputedStyle(targetElement)
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
                    let el: Element | null = null

                    if (h.selector.includes(':') || h.selector.includes('::')) {
                        const simplifiedSelector = h.selector.split(/[:]/)[0]
                        const simplifiedMatches = document.querySelectorAll(simplifiedSelector)
                        if (simplifiedMatches.length > 0) {
                            el = simplifiedMatches[0]
                        }
                    }

                    if (!el && (h.explanation.toLowerCase().includes('button') || h.explanation.toLowerCase().includes('btn'))) {
                        const buttonElements = findButtonLikeElements(h.explanation)
                        if (buttonElements.length > 0) {
                            el = buttonElements[0]
                            console.log(`Site Tutor: Using fallback button finder for: ${h.explanation}`, {
                                foundElement: el,
                                totalButtonsFound: buttonElements.length
                            })
                        }
                    }

                    // Always try fallback for input/field elements, especially for description fields
                    if (!el && (h.explanation.toLowerCase().includes('input') ||
                               h.explanation.toLowerCase().includes('field') ||
                               h.explanation.toLowerCase().includes('enter') ||
                               h.explanation.toLowerCase().includes('check') ||
                               h.explanation.toLowerCase().includes('select') ||
                               h.explanation.toLowerCase().includes('choose') ||
                               h.explanation.toLowerCase().includes('public') ||
                               h.explanation.toLowerCase().includes('private') ||
                               h.explanation.toLowerCase().includes('readme') ||
                               h.explanation.toLowerCase().includes('description') ||
                               h.explanation.toLowerCase().includes('desc'))) {
                        // For description fields, try direct name attribute search first
                        if (h.explanation.toLowerCase().includes('description') || h.explanation.toLowerCase().includes('desc')) {
                            const allInputs = Array.from(document.querySelectorAll('input, textarea'))
                            for (const input of allInputs) {
                                const name = input.getAttribute('name')?.toLowerCase() || ''
                                const id = input.getAttribute('id')?.toLowerCase() || ''
                                const placeholder = input.getAttribute('placeholder')?.toLowerCase() || ''
                                
                                // Check if this input is related to description
                                if (name.includes('description') || name.includes('desc') ||
                                    id.includes('description') || id.includes('desc') ||
                                    placeholder.includes('description') || placeholder.includes('desc')) {
                                    const rect = input.getBoundingClientRect()
                                    const style = window.getComputedStyle(input)
                                    if (rect.width > 0 && rect.height > 0 &&
                                        style.display !== 'none' &&
                                        style.visibility !== 'hidden' &&
                                        style.opacity !== '0') {
                                        el = input
                                        console.log(`Site Tutor: Found description field by name/id/placeholder`, {
                                            foundElement: el,
                                            name,
                                            id,
                                            placeholder
                                        })
                                        break
                                    }
                                }
                            }
                        }
                        
                        // If still not found, use the general explanation-based finder
                        if (!el) {
                            const element = findElementByExplanation(h.explanation, h.selector)
                            if (element) {
                                el = element
                                console.log(`Site Tutor: Using fallback element finder for: ${h.explanation}`, {
                                    foundElement: el,
                                    selector: h.selector
                                })
                            }
                        }
                    }

                    if (el) {
                        // Find the best element to highlight (container for inputs, element itself for buttons/headings)
                        const targetElement = findContainerElement(el)
                        const rect = targetElement.getBoundingClientRect()
                        const style = window.getComputedStyle(targetElement)
                        if (rect.width > 0 && rect.height > 0 &&
                            style.display !== 'none' &&
                            style.visibility !== 'hidden') {
                            newExpandedHighlights.push({ highlight: h, rect })
                        }
                    } else {
                        console.warn(`Site Tutor: Could not find element for selector: ${h.selector}`, {
                            explanation: h.explanation,
                            selector: h.selector,
                            pageUrl: window.location.href,
                            currentStepIndex
                        })
                    }
                }
            } catch (e) {
                console.error(`Site Tutor: Invalid selector ${h.selector}`, e)
            }
        })

        setExpandedHighlights(newExpandedHighlights)
    }, [highlights, currentStepIndex])

    useEffect(() => {
        const timeoutId = setTimeout(updateRects, 100)

        const handleResize = () => updateRects()
        const handleScroll = () => updateRects()

        window.addEventListener('resize', handleResize)
        window.addEventListener('scroll', handleScroll, { capture: true, passive: true })

        const observer = new MutationObserver(() => {
            setTimeout(updateRects, 50)
        })
        observer.observe(document.body, { childList: true, subtree: true, attributes: true })

        return () => {
            clearTimeout(timeoutId)
            window.removeEventListener('resize', handleResize)
            window.removeEventListener('scroll', handleScroll)
            observer.disconnect()
        }
    }, [updateRects])

    return (
        <div className="fixed inset-0 pointer-events-none z-[99998] overflow-hidden">
            <AnimatePresence>
                {expandedHighlights.map(({ highlight, rect }, i) => {
                    if (rect.width === 0 || rect.height === 0) return null

                    const isGuidedStep = typeof currentStepIndex === 'number'
                    const stepLabel = isGuidedStep ? `Step ${currentStepIndex + 1}` : null

                    return (
                        <motion.div
                            key={`${i}-${highlight.selector}-${rect.top}-${rect.left}-${isGuidedStep ? currentStepIndex : 'all'}`}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className={`absolute border-4 border-red-500 rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.5)] bg-red-500/10 box-border${isGuidedStep ? ' animate-pulse' : ''}`}
                            style={{
                                top: rect.top,
                                left: rect.left,
                                width: rect.width,
                                height: rect.height,
                            }}
                        >
                            <div className="absolute -top-10 left-0 bg-red-500 text-white font-bold px-3 py-1 rounded shadow-md whitespace-nowrap text-sm z-50 pointer-events-auto flex items-center gap-2">
                                {stepLabel && <span className="text-[10px] uppercase tracking-wide text-white/80">{stepLabel}</span>}
                                <span>{highlight.explanation}</span>
                            </div>
                        </motion.div>
                    )
                })}
            </AnimatePresence>
        </div>
    )
}

export default Overlay
