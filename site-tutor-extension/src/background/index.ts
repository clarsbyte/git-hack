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
})
