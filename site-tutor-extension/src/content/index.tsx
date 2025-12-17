import React from 'react'
import ReactDOM from 'react-dom/client'
import Chatbot from '../components/Chatbot'
import styles from '../index.css?inline'
import { getSimplifiedDom } from '../utils/domSanitizer'

const root = document.createElement('div')
root.id = 'site-tutor-root'
document.body.appendChild(root)

const shadow = root.attachShadow({ mode: 'open' })

// Create a style element for Tailwind
const styleElement = document.createElement('style')
styleElement.textContent = styles
shadow.appendChild(styleElement)

const shadowRoot = document.createElement('div')
shadowRoot.id = 'shadow-root'
shadow.appendChild(shadowRoot)

ReactDOM.createRoot(shadowRoot).render(
    <React.StrictMode>
        <Chatbot />
    </React.StrictMode>
)

if (typeof window !== 'undefined') {
    ;(window as typeof window & { __siteTutorDomSnapshot?: () => unknown }).__siteTutorDomSnapshot = () => getSimplifiedDom(document)
}

export { getSimplifiedDom }
