import React from 'react'
import ReactDOM from 'react-dom/client'
import Chatbot from '../components/Chatbot'
import styles from '../index.css?inline'
import { getSimplifiedDom } from '../utils/domSanitizer'
import { ElementIndexer } from '../utils/elementIndexer'

// Initialize extension when DOM is ready
function initExtension() {
    // Check if already initialized
    if (document.getElementById('site-tutor-root')) {
        console.log('Site Tutor: Already initialized')
        return
    }

    // Ensure body exists
    if (!document.body) {
        console.log('Site Tutor: Body not ready, waiting...')
        setTimeout(initExtension, 100)
        return
    }

    console.log('Site Tutor: Initializing extension')

    const root = document.createElement('div')
    root.id = 'site-tutor-root'
    root.style.position = 'fixed'
    root.style.bottom = '0'
    root.style.right = '0'
    root.style.width = '0'
    root.style.height = '0'
    root.style.zIndex = '2147483647'
    root.style.pointerEvents = 'auto'
    document.body.appendChild(root)

    const shadow = root.attachShadow({ mode: 'open' })

    // Create a style element for Tailwind
    const styleElement = document.createElement('style')
    styleElement.textContent = styles
    shadow.appendChild(styleElement)

    const shadowRoot = document.createElement('div')
    shadowRoot.id = 'shadow-root'
    shadow.appendChild(shadowRoot)

    const stopShortcutPropagation = (event: Event) => {
        event.stopPropagation()
        event.stopImmediatePropagation()
    }

    // Stop key events from bubbling to the host page, while still letting
    // the input handlers inside the shadow root receive them.
    shadow.addEventListener('keydown', stopShortcutPropagation)
    shadow.addEventListener('keypress', stopShortcutPropagation)
    shadow.addEventListener('keyup', stopShortcutPropagation)

    ReactDOM.createRoot(shadowRoot).render(
        <React.StrictMode>
            <Chatbot />
        </React.StrictMode>
    )

    const elementIndexer = new ElementIndexer()

    if (typeof window !== 'undefined') {
        ;(window as typeof window & { __siteTutorDomSnapshot?: () => unknown }).__siteTutorDomSnapshot = () => getSimplifiedDom(document)
        ;(window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer = elementIndexer
    }

    console.log('Site Tutor: Extension initialized successfully')

    // Watch for removal and re-inject if needed
    const observer = new MutationObserver(() => {
        const rootStillExists = document.getElementById('site-tutor-root')
        if (!rootStillExists) {
            console.log('Site Tutor: Extension removed from DOM, re-injecting...')
            observer.disconnect()
            setTimeout(initExtension, 100)
        }
    })

    observer.observe(document.body, {
        childList: true,
        subtree: false
    })
}

// Start initialization
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtension)
} else {
    initExtension()
}

export { getSimplifiedDom }
