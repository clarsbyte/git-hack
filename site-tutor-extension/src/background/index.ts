const REANALYZE_RETRY_DELAYS_MS = [0, 250, 900, 2200]

const requestDomReanalysis = (tabId: number, reason: string) => {
    for (const [index, delay] of REANALYZE_RETRY_DELAYS_MS.entries()) {
        setTimeout(() => {
            chrome.tabs.sendMessage(tabId, {
                action: 'forceReanalyzeDom',
                reason,
                attempt: index + 1,
            }).catch(() => {
                // Ignore tabs without an injected content script.
            })
        }, delay)
    }
}

// Background service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'captureScreen') {
        chrome.tabs.captureVisibleTab(
            { format: 'png' },
            (dataUrl) => {
                sendResponse({ dataUrl })
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
        requestDomReanalysis(tabId, request.reason ?? 'content-force')
        sendResponse({ ok: true })
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!tabId) return

    if (changeInfo.status === 'complete') {
        requestDomReanalysis(tabId, 'tabs-onUpdated-complete')
        return
    }

    if (typeof changeInfo.url === 'string' && changeInfo.url.length > 0) {
        requestDomReanalysis(tabId, 'tabs-onUpdated-url')
    }
})

// Ensure re-analysis when the user switches back to a tab.
chrome.tabs.onActivated.addListener((activeInfo) => {
    requestDomReanalysis(activeInfo.tabId, 'tabs-onActivated')
})

// Catch SPA history API URL changes at the browser level (main frame only).
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return
    requestDomReanalysis(details.tabId, 'webNavigation-onHistoryStateUpdated')
})

// Catch committed top-level navigations early.
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return
    requestDomReanalysis(details.tabId, 'webNavigation-onCommitted')
})
