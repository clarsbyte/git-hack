/**
 * Utility for taking clean screenshots without Site Tutor UI visible
 * Uses visibility:hidden for instant, flicker-free hiding
 */

interface HiddenElements {
    root: HTMLElement | null
    originalVisibility: string
    originalPointerEvents: string
    originalTransition: string
}

/**
 * Make Site Tutor UI invisible for screenshots (instant, no flicker)
 * Uses visibility:hidden which is immediate and doesn't trigger any visual changes
 * Returns state object needed to restore UI
 */
export function hideSiteTutorUI(): HiddenElements {
    const root = document.getElementById('site-tutor-root')

    const state: HiddenElements = {
        root,
        originalVisibility: root?.style.visibility || '',
        originalPointerEvents: root?.style.pointerEvents || '',
        originalTransition: root?.style.transition || ''
    }

    if (root) {
        // Disable any CSS transitions to ensure instant hiding
        root.style.transition = 'none'
        // Make invisible to screenshots (instant, no reflow, no flicker)
        root.style.visibility = 'hidden'
        root.style.pointerEvents = 'none'
    }

    return state
}

/**
 * Restore Site Tutor UI visibility after screenshot
 */
export function restoreSiteTutorUI(state: HiddenElements): void {
    if (state.root) {
        state.root.style.visibility = state.originalVisibility
        state.root.style.pointerEvents = state.originalPointerEvents
        state.root.style.transition = state.originalTransition
    }
}

/**
 * Take a clean screenshot with UI hidden
 * Coordinates with background script
 */
export async function captureCleanScreenshot(): Promise<string | null> {
    // Hide UI
    const hiddenState = hideSiteTutorUI()

    try {
        // Wait for a frame to ensure UI is hidden
        await new Promise(resolve => requestAnimationFrame(resolve))

        // Request screenshot from background script
        const response = await chrome.runtime.sendMessage({
            type: 'CAPTURE_SCREENSHOT'
        })

        return response?.screenshot || null
    } finally {
        // Always restore UI, even if screenshot fails
        restoreSiteTutorUI(hiddenState)
    }
}

/**
 * Get viewport dimensions (visible area, excluding browser chrome)
 */
export function getViewportDimensions(): { width: number; height: number } {
    return {
        width: window.innerWidth,
        height: window.innerHeight
    }
}

/**
 * Get scroll position
 */
export function getScrollPosition(): { x: number; y: number } {
    return {
        x: window.scrollX || window.pageXOffset,
        y: window.scrollY || window.pageYOffset
    }
}
