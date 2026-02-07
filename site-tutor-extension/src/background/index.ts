type TransitionContext = {
    previousUrl: string | null
    currentUrl: string | null
    transitionSource: string
    observedAt: number
}

type PendingReanalysisRequest = {
    reason: string
    context: TransitionContext
}

type TabRuntimeState = {
    contentReady: boolean
    lastKnownUrl: string | null
    lastContext: TransitionContext | null
    pending: PendingReanalysisRequest[]
}

const tabRuntime = new Map<number, TabRuntimeState>()

const getTabState = (tabId: number): TabRuntimeState => {
    const existing = tabRuntime.get(tabId)
    if (existing) return existing
    const initial: TabRuntimeState = {
        contentReady: false,
        lastKnownUrl: null,
        lastContext: null,
        pending: [],
    }
    tabRuntime.set(tabId, initial)
    return initial
}

const createTransitionContext = (
    tabId: number,
    source: string,
    nextUrl?: string | null
): TransitionContext => {
    const state = getTabState(tabId)
    const previousUrl = state.lastKnownUrl
    const currentUrl = typeof nextUrl === 'string' && nextUrl.length > 0
        ? nextUrl
        : (state.lastKnownUrl ?? null)

    if (typeof currentUrl === 'string' && currentUrl.length > 0) {
        state.lastKnownUrl = currentUrl
    }

    const context: TransitionContext = {
        previousUrl,
        currentUrl,
        transitionSource: source,
        observedAt: Date.now(),
    }
    state.lastContext = context
    return context
}

const sendReanalysisMessage = async (
    tabId: number,
    reason: string,
    context: TransitionContext,
    attempt: number
): Promise<boolean> => {
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'forceReanalyzeDom',
            reason,
            attempt,
            previousUrl: context.previousUrl,
            currentUrl: context.currentUrl,
            transitionSource: context.transitionSource,
            observedAt: context.observedAt,
        })
        return true
    } catch {
        return false
    }
}

const enqueueReanalysis = (tabId: number, reason: string, context: TransitionContext) => {
    const state = getTabState(tabId)
    const existing = state.pending.find(
        item => item.reason === reason && item.context.currentUrl === context.currentUrl
    )
    if (!existing) {
        state.pending.push({ reason, context })
    }
}

const flushPendingReanalysis = async (tabId: number): Promise<void> => {
    const state = getTabState(tabId)
    if (!state.contentReady) return
    if (state.pending.length === 0) return

    const queue = [...state.pending]
    state.pending = []

    for (const [idx, item] of queue.entries()) {
        const ok = await sendReanalysisMessage(tabId, item.reason, item.context, idx + 1)
        if (!ok) {
            state.contentReady = false
            enqueueReanalysis(tabId, item.reason, item.context)
            break
        }
    }
}

const requestDomReanalysis = async (
    tabId: number,
    reason: string,
    explicitUrl?: string | null
) => {
    const state = getTabState(tabId)
    const context = createTransitionContext(tabId, reason, explicitUrl)

    if (!state.contentReady) {
        enqueueReanalysis(tabId, reason, context)
        return
    }

    const ok = await sendReanalysisMessage(tabId, reason, context, 1)
    if (!ok) {
        state.contentReady = false
        enqueueReanalysis(tabId, reason, context)
    }
}

// Background service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Screenshot capture for VLM integration
    if (request.type === 'CAPTURE_SCREENSHOT' || request.action === 'captureScreen') {
        chrome.tabs.captureVisibleTab(
            { format: 'png' },
            (dataUrl) => {
                if (request.type === 'CAPTURE_SCREENSHOT') {
                    sendResponse({ screenshot: dataUrl })
                } else {
                    sendResponse({ dataUrl })
                }
            }
        )
        return true // Indicates async response
    }

    if (request.action === 'getTabId') {
        sendResponse({ tabId: sender.tab?.id ?? null })
    }

    if (request.action === 'forceReanalyzeTab') {
        const tabId = sender.tab?.id
        if (!tabId) {
            sendResponse({ ok: false })
            return
        }
        void requestDomReanalysis(tabId, request.reason ?? 'content-force')
        sendResponse({ ok: true })
        return
    }

    if (request.action === 'contentScriptReady') {
        const tabId = sender.tab?.id
        if (!tabId) {
            sendResponse({ ok: false })
            return
        }

        const state = getTabState(tabId)
        state.contentReady = true

        if (typeof request.url === 'string' && request.url.length > 0) {
            if (!state.lastKnownUrl) {
                state.lastKnownUrl = request.url
            } else if (state.lastKnownUrl !== request.url && !state.lastContext) {
                state.lastContext = {
                    previousUrl: state.lastKnownUrl,
                    currentUrl: request.url,
                    transitionSource: 'contentScriptReady',
                    observedAt: Date.now(),
                }
                state.lastKnownUrl = request.url
            }
        }

        void flushPendingReanalysis(tabId)
        sendResponse({ ok: true, pendingCount: state.pending.length })
        return
    }

    if (request.action === 'injectHistoryPatcher') {
        const tabId = sender.tab?.id
        if (!tabId) {
            sendResponse({ ok: false })
            return
        }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                if ((window as any).__siteTutorMainWorldPatched) return
                ;(window as any).__siteTutorMainWorldPatched = true
                const origPush = history.pushState.bind(history)
                const origReplace = history.replaceState.bind(history)
                history.pushState = function (data: any, unused: string, url?: string | URL | null) {
                    const r = origPush(data, unused, url)
                    document.dispatchEvent(new CustomEvent('siteTutor:historyChange'))
                    return r
                }
                history.replaceState = function (data: any, unused: string, url?: string | URL | null) {
                    const r = origReplace(data, unused, url)
                    document.dispatchEvent(new CustomEvent('siteTutor:historyChange'))
                    return r
                }
            },
        }).then(() => {
            sendResponse({ ok: true })
        }).catch((err) => {
            console.warn('Failed to inject history patcher:', err)
            sendResponse({ ok: false })
        })
        return true // async response
    }
})

// Force content scripts to refresh DOM indexing when tabs navigate/load.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tabId) return
    const state = getTabState(tabId)

    if (changeInfo.status === 'loading') {
        state.contentReady = false
    }

    if (changeInfo.status === 'complete') {
        void requestDomReanalysis(tabId, 'tabs-onUpdated-complete', tab?.url ?? state.lastKnownUrl)
        return
    }

    if (typeof changeInfo.url === 'string' && changeInfo.url.length > 0) {
        state.contentReady = false
        void requestDomReanalysis(tabId, 'tabs-onUpdated-url', changeInfo.url)
    }
})

// Ensure re-analysis when the user switches back to a tab.
chrome.tabs.onActivated.addListener((activeInfo) => {
    void requestDomReanalysis(activeInfo.tabId, 'tabs-onActivated')
})

// Catch SPA history API URL changes at the browser level (main frame only).
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return
    void requestDomReanalysis(details.tabId, 'webNavigation-onHistoryStateUpdated', details.url)
})

// Catch committed top-level navigations early.
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return
    const state = getTabState(details.tabId)
    state.contentReady = false
    void requestDomReanalysis(details.tabId, 'webNavigation-onCommitted', details.url)
})

chrome.tabs.onRemoved.addListener((tabId) => {
    tabRuntime.delete(tabId)
})
