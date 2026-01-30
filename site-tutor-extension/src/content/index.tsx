import React from 'react'
import ReactDOM from 'react-dom/client'
import Chatbot from '../components/Chatbot'
import styles from '../index.css?inline'
import { getSimplifiedDom } from '../utils/domSanitizer'
import { ElementIndexer } from '../utils/elementIndexer'

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

const stopShortcutPropagation = (event: KeyboardEvent) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const target = event.target as Node | null
    const isInsideShadow = path.includes(shadowRoot) || (target ? shadowRoot.contains(target) : false)
    if (isInsideShadow) {
        event.stopPropagation()
        event.stopImmediatePropagation()
    }
}

document.addEventListener('keydown', stopShortcutPropagation, true)
document.addEventListener('keypress', stopShortcutPropagation, true)
document.addEventListener('keyup', stopShortcutPropagation, true)

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

export { getSimplifiedDom }
