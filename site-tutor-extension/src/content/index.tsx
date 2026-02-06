import React from 'react'
import ReactDOM from 'react-dom/client'
import Chatbot from '../components/Chatbot'
import styles from '../index.css?inline'
import { getSimplifiedDom } from '../utils/domSanitizer'
import { ElementIndexer } from '../utils/elementIndexer'

const PAGE_CHANGED_EVENT = 'siteTutor:pageChanged'

/**
 * Inject a history patcher into the page's MAIN WORLD.
 *
 * Content scripts run in an isolated world, so patching history from
 * here does NOT intercept calls made by the website's own JavaScript.
 * We use two strategies:
 *
 * 1. chrome.scripting.executeScript({ world: "MAIN" }) via the
 *    background service worker – works on ALL sites (bypasses CSP).
 * 2. Inline <script> fallback – works on sites without strict CSP.
 *
 * Both dispatch on `document` which IS shared between worlds.
 */
function injectMainWorldHistoryPatcher() {
    // Strategy 1: Use chrome.scripting via background (CSP-safe)
    try {
        chrome.runtime.sendMessage({ action: 'injectHistoryPatcher' }, (resp) => {
            if (chrome.runtime.lastError || !resp?.ok) {
                console.log('Site Tutor: Background injection failed, trying inline script fallback')
                injectInlineHistoryPatcher()
            } else {
                console.log('Site Tutor: History patcher injected via background (main world)')
            }
        })
    } catch {
        injectInlineHistoryPatcher()
    }
}

/** Strategy 2: Inline <script> tag – blocked by strict CSP (e.g. GitHub) */
function injectInlineHistoryPatcher() {
    try {
        const script = document.createElement('script')
        script.textContent = `(function(){
            if(window.__siteTutorMainWorldPatched) return;
            window.__siteTutorMainWorldPatched = true;
            var origPush = history.pushState;
            var origReplace = history.replaceState;
            history.pushState = function(){
                var r = origPush.apply(this, arguments);
                document.dispatchEvent(new CustomEvent('siteTutor:historyChange'));
                return r;
            };
            history.replaceState = function(){
                var r = origReplace.apply(this, arguments);
                document.dispatchEvent(new CustomEvent('siteTutor:historyChange'));
                return r;
            };
        })();`
        document.documentElement.appendChild(script)
        script.remove()
    } catch (e) {
        console.warn('Site Tutor: Inline history patcher also failed (CSP):', e)
    }
}

/**
 * Start watching for page changes via ALL mechanisms:
 *
 * 1. `document` 'siteTutor:historyChange' – fired by the main-world
 *    script when the site calls pushState / replaceState (SPA nav).
 * 2. `window` 'popstate' / 'hashchange' – browser back/forward.
 * 3. MutationObserver on `<body>` – catches large-scale DOM replacements
 *    that SPAs do (GitHub Turbo, React Router, etc.) even if we miss
 *    the URL change for any reason.
 * 4. Polling every 400ms – ultimate safety net.
 *
 * All paths converge into `handlePageShift()` which re-indexes the DOM
 * and dispatches a single `siteTutor:pageChanged` event on `window`
 * for the React components living in the same content-script world.
 */
function startPageChangeWatcher() {
    let lastUrl = window.location.href
    let lastBodySignature = getBodySignature()
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    /** Lightweight signature of body's direct children to detect major swaps. */
    function getBodySignature(): string {
        if (!document.body) return ''
        const children = document.body.children
        // Hash tag names + ids of first 20 direct children
        let sig = ''
        const len = Math.min(children.length, 20)
        for (let i = 0; i < len; i++) {
            const el = children[i]
            if (el.id === 'site-tutor-root') continue
            sig += el.tagName + (el.id ? '#' + el.id : '') + ','
        }
        return sig
    }

    function reanalyzeDom(reason: string, detail?: Record<string, unknown>) {
        lastUrl = window.location.href
        lastBodySignature = getBodySignature()
        console.log(`Site Tutor: Re-analyzing DOM (${reason}) →`, lastUrl)
        const indexer = (window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer
        if (indexer) {
            indexer.indexPage(document)
        }
        window.dispatchEvent(new CustomEvent(PAGE_CHANGED_EVENT, { detail: { url: lastUrl, reason, ...detail } }))
    }

    function handlePageShift(reason: string = 'page-shift') {
        reanalyzeDom(reason)
    }

    function debouncedShift() {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => handlePageShift('debounced-page-shift'), 300)
    }

    function checkUrl() {
        if (window.location.href !== lastUrl) {
            debouncedShift()
        }
    }

    // ── 1. Main-world history change (document event IS cross-world) ──
    document.addEventListener('siteTutor:historyChange', () => {
        checkUrl()
    })

    // ── 2. Browser back / forward / hash ──
    window.addEventListener('popstate', checkUrl)
    window.addEventListener('hashchange', checkUrl)

    // Page lifecycle events cover hard navigations, bfcache restores,
    // and cases where URL can remain the same while DOM is rebuilt.
    window.addEventListener('pageshow', () => reanalyzeDom('pageshow'))
    window.addEventListener('load', () => reanalyzeDom('load'))
    window.addEventListener('focus', () => reanalyzeDom('focus'))
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            reanalyzeDom('visibility-visible')
        }
    })
    document.addEventListener('readystatechange', () => {
        if (document.readyState === 'complete') {
            reanalyzeDom('readystatechange-complete')
        }
    })

    // Background-triggered fallback for tab updates/new page loads.
    chrome.runtime.onMessage.addListener((message) => {
        if (message?.action === 'forceReanalyzeDom') {
            reanalyzeDom(message?.reason || 'background-force')
        }
    })

    // ── 3. MutationObserver for major DOM changes ──
    if (document.body) {
        const domObserver = new MutationObserver(() => {
            // Check if URL changed
            if (window.location.href !== lastUrl) {
                debouncedShift()
                return
            }
            // Check if body structure changed significantly (SPA swapped content)
            const newSig = getBodySignature()
            if (newSig !== lastBodySignature) {
                console.log('Site Tutor: DOM structure shift detected')
                debouncedShift()
            }
        })
        domObserver.observe(document.body, { childList: true, subtree: false })

        // Also watch deeper – some SPAs swap content inside a wrapper, not body
        // We watch subtree but only react if many nodes changed at once
        let deepDebounce: ReturnType<typeof setTimeout> | null = null
        let pendingDeepChanges = 0
        const deepObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                pendingDeepChanges += m.addedNodes.length + m.removedNodes.length
            }
            if (pendingDeepChanges > 15) {
                if (deepDebounce) clearTimeout(deepDebounce)
                deepDebounce = setTimeout(() => {
                    if (pendingDeepChanges > 15) {
                        console.log(`Site Tutor: Major DOM mutation (${pendingDeepChanges} nodes)`)
                        // Re-index but only fire pageChanged if URL also changed or body sig changed
                        const indexer = (window as typeof window & { __siteTutorElementIndexer?: ElementIndexer }).__siteTutorElementIndexer
                        if (indexer) {
                            indexer.indexPage(document)
                        }
                        const newSig = getBodySignature()
                        if (window.location.href !== lastUrl || newSig !== lastBodySignature) {
                            handlePageShift('major-dom-mutation-with-page-shift')
                        } else {
                            // DOM changed but URL didn't – still notify so highlights refresh
                            reanalyzeDom('major-dom-mutation', { domOnly: true })
                        }
                    }
                    pendingDeepChanges = 0
                }, 500)
            }
        })
        deepObserver.observe(document.body, { childList: true, subtree: true })
    }

    // ── 4. Polling fallback ──
    setInterval(checkUrl, 400)

    // Ensure we always do one fresh analysis when watcher starts.
    reanalyzeDom('watcher-start')
}

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

    // Inject history patcher into page's main world FIRST
    injectMainWorldHistoryPatcher()

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

    // Initial page analysis on first injection.
    elementIndexer.indexPage(document)

    console.log('Site Tutor: Extension initialized successfully')

    // Start comprehensive page change watcher
    startPageChangeWatcher()

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

function startPersistenceWatchdog() {
    const win = window as typeof window & {
        __siteTutorWatchdogStarted?: boolean
        __siteTutorWatchdogId?: ReturnType<typeof setInterval>
    }

    if (win.__siteTutorWatchdogStarted) return
    win.__siteTutorWatchdogStarted = true

    const ensureMounted = () => {
        const root = document.getElementById('site-tutor-root')
        if (!root || !root.isConnected || !root.shadowRoot) {
            console.log('Site Tutor: watchdog re-injecting extension root')
            initExtension()
        }
    }

    win.__siteTutorWatchdogId = setInterval(ensureMounted, 1200)
    window.addEventListener('pageshow', ensureMounted)
    window.addEventListener('focus', ensureMounted)
}

// Start initialization
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initExtension()
        startPersistenceWatchdog()
    })
} else {
    initExtension()
    startPersistenceWatchdog()
}

export { getSimplifiedDom }
