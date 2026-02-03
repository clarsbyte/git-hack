import type { EnhancedStepRecord, ActionHistoryEntry } from '../types/tutorial'

/**
 * RouteTracker - Captures exact user actions and page state
 * Tracks which route the user is following through a tutorial
 */
export class RouteTracker {
  private history: ActionHistoryEntry[] = []
  private sessionId: string
  private maxHistorySize: number = 50 // Limit memory usage

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /**
   * Capture element that was clicked
   * Returns XPath, CSS selector, text, and tag name
   */
  captureClickedElement(element: HTMLElement): EnhancedStepRecord['clickedElement'] {
    return {
      xpath: this.getXPath(element),
      selector: this.getCSSSelector(element),
      elementText: element.textContent?.trim() || '',
      tagName: element.tagName
    }
  }

  /**
   * Generate XPath for any element
   * Walks up the DOM tree building an XPath expression
   * Example: "/html/body/div[1]/button[2]"
   */
  private getXPath(element: HTMLElement): string {
    if (element.id) {
      return `//*[@id="${element.id}"]`
    }

    const parts: string[] = []
    let current: HTMLElement | null = element

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 0
      let sibling: Element | null = current

      // Count preceding siblings of the same type
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) {
          index++
        }
        sibling = sibling.previousElementSibling
      }

      const tagName = current.nodeName.toLowerCase()
      const pathIndex = index > 1 ? `[${index}]` : ''
      parts.unshift(`${tagName}${pathIndex}`)

      current = current.parentElement
    }

    return '/' + parts.join('/')
  }

  /**
   * Generate stable CSS selector
   * Prefers: data-testid > id > class + nth-child
   */
  private getCSSSelector(element: HTMLElement): string {
    // Prefer data-testid if available
    const testId = element.getAttribute('data-testid')
    if (testId) {
      return `[data-testid="${testId}"]`
    }

    // Use ID if available
    if (element.id) {
      return `#${element.id}`
    }

    // Build selector using classes and nth-child
    const parts: string[] = []
    let current: HTMLElement | null = element

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase()

      // Add classes if they exist and are stable
      if (current.className && typeof current.className === 'string') {
        const classes = current.className
          .split(/\s+/)
          .filter(cls => cls && !cls.match(/^(active|focus|hover|disabled)/i))
          .slice(0, 2) // Limit to 2 classes

        if (classes.length > 0) {
          selector += '.' + classes.join('.')
        }
      }

      // Add nth-child for specificity
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children)
        const index = siblings.indexOf(current) + 1
        selector += `:nth-child(${index})`
      }

      parts.unshift(selector)
      current = current.parentElement

      // Stop if we have a unique enough selector
      if (parts.length >= 3) break
    }

    return parts.join(' > ')
  }

  /**
   * Create page state snapshot
   * Captures URL, title, and DOM hash
   */
  capturePageState(): NonNullable<EnhancedStepRecord['pageState']> {
    return {
      url: window.location.href,
      urlHash: this.getUrlWithoutParams(window.location.href),
      title: document.title,
      domHash: this.generateDOMHash(),
      timestamp: Date.now()
    }
  }

  /**
   * Remove query parameters from URL for comparison
   */
  private getUrlWithoutParams(url: string): string {
    try {
      const urlObj = new URL(url)
      return urlObj.origin + urlObj.pathname
    } catch {
      return url.split('?')[0]
    }
  }

  /**
   * Generate hash of critical DOM elements
   * Hashes combination of:
   * - Main content area HTML structure
   * - Visible button/link text
   * - Form field labels
   */
  private generateDOMHash(): string {
    const elements: string[] = []

    // Get main content indicators
    const mainContent = document.querySelector('main') ||
                       document.querySelector('[role="main"]') ||
                       document.body

    // Collect structural elements
    mainContent.querySelectorAll('h1, h2, h3, button, a, input, label').forEach(el => {
      if (this.isVisible(el)) {
        const text = el.textContent?.trim().substring(0, 50) || ''
        if (text) {
          elements.push(`${el.tagName}:${text}`)
        }
      }
    })

    // Create simple hash
    const str = elements.slice(0, 30).join('|')
    return this.simpleHash(str)
  }

  /**
   * Simple string hash function
   */
  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36)
  }

  /**
   * Check if element is visible on screen
   */
  private isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  /**
   * Record an action in history
   */
  recordAction(entry: ActionHistoryEntry): void {
    this.history.push(entry)

    // Limit history size to prevent memory issues
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize)
    }
  }

  /**
   * Get full action history
   */
  getHistory(): ActionHistoryEntry[] {
    return [...this.history]
  }

  /**
   * Detect if we're on expected route
   * Compares current URL and DOM hash against expected values
   */
  isOnExpectedRoute(expectedUrl: string, expectedDomHash?: string): boolean {
    const current = this.capturePageState()
    const urlMatches = current.urlHash === this.getUrlWithoutParams(expectedUrl)
    const domMatches = !expectedDomHash || current.domHash === expectedDomHash
    return urlMatches && domMatches
  }

  /**
   * Clear history (useful when tutorial ends)
   */
  clearHistory(): void {
    this.history = []
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId
  }
}
