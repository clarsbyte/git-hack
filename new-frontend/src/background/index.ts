// Background service worker
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'captureScreen') {
        chrome.tabs.captureVisibleTab(
            { format: 'png' },
            (dataUrl) => {
                sendResponse({ dataUrl });
            }
        );
        return true; // Indicates async response
    }
});

