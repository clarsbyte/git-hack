import { isElementHidden, isInteractiveElement, IGNORED_TAGS } from './domSanitizer'

const MAX_ELEMENTS = 200

interface ElementMetadata {
    index: number
    element: HTMLElement
    rect: DOMRect
    viewportStatus: 'in-viewport' | 'above-fold' | 'below-fold'
    scrollPosition: number
}

export class ElementIndexer {
    private elementMap: Map<number, HTMLElement> = new Map()
    private metadata: Map<number, ElementMetadata> = new Map()
    private nextIndex = 0

    indexPage(root?: Document | ShadowRoot): void {
        this.elementMap.clear()
        this.metadata.clear()
        this.nextIndex = 0
        const targetRoot = root ?? document

        const interactiveElements: HTMLElement[] = []
        const visibleElements: HTMLElement[] = []

        this.walkDOM(targetRoot, (el) => {
            if (isInteractiveElement(el)) {
                interactiveElements.push(el as HTMLElement)
            } else {
                visibleElements.push(el as HTMLElement)
            }
        })

        // Prioritize interactive elements, then visible ones up to cap
        for (const el of interactiveElements) {
            if (this.nextIndex >= MAX_ELEMENTS) break
            this.elementMap.set(this.nextIndex, el)
            this.nextIndex++
        }
        for (const el of visibleElements) {
            if (this.nextIndex >= MAX_ELEMENTS) break
            this.elementMap.set(this.nextIndex, el)
            this.nextIndex++
        }

        // Calculate viewport metadata for all indexed elements
        this.calculateViewportMetadata()
    }

    private calculateViewportMetadata(): void {
        const viewportHeight = window.innerHeight
        const scrollY = window.scrollY

        for (const [index, el] of this.elementMap) {
            const rect = el.getBoundingClientRect()
            const absoluteTop = rect.top + scrollY

            let status: 'in-viewport' | 'above-fold' | 'below-fold'
            if (rect.top >= 0 && rect.bottom <= viewportHeight) {
                status = 'in-viewport'
            } else if (absoluteTop < scrollY) {
                status = 'above-fold'
            } else {
                status = 'below-fold'
            }

            this.metadata.set(index, {
                index,
                element: el,
                rect,
                viewportStatus: status,
                scrollPosition: scrollY
            })
        }
    }

    private walkDOM(root: Document | ShadowRoot | Element, callback: (el: Element) => void, depth = 0): void {
        if (depth > 50) return

        const children = root instanceof Document || root instanceof ShadowRoot
            ? Array.from(root.children)
            : Array.from(root.children)

        for (const child of children) {
            const tag = child.tagName?.toLowerCase()
            if (!tag) continue
            if (IGNORED_TAGS.has(tag)) continue

            // Skip #site-tutor-root and all descendants
            if (child.id === 'site-tutor-root') continue

            if (isElementHidden(child)) continue

            // Check if this element is worth indexing
            if (child instanceof HTMLElement) {
                const isInteractive = isInteractiveElement(child)
                const hasText = (child.textContent?.trim().length ?? 0) > 0
                const isVisible = this.isVisibleInViewport(child)

                if (isInteractive || (hasText && isVisible)) {
                    callback(child)
                }
            }

            // Traverse shadow DOM
            const host = child as HTMLElement & { shadowRoot?: ShadowRoot | null }
            if (host.shadowRoot) {
                this.walkDOM(host.shadowRoot, callback, depth + 1)
            }

            this.walkDOM(child, callback, depth + 1)
        }
    }

    private isVisibleInViewport(el: HTMLElement): boolean {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
    }

    private getViewportOriginInScreenCssPx(): { x: number; y: number } {
        // Approximate the top-left of the content viewport in screen CSS pixels.
        // This lets us project DOM rects into full-screen desktop capture space.
        const horizontalChrome = Math.max(0, window.outerWidth - window.innerWidth)
        const verticalChrome = Math.max(0, window.outerHeight - window.innerHeight)
        const viewportScreenX = window.screenX + (horizontalChrome / 2)
        const viewportScreenY = window.screenY + verticalChrome
        return { x: viewportScreenX, y: viewportScreenY }
    }

    private getScreenBBox(rect: DOMRect): { x: number; y: number; width: number; height: number } {
        const dpr = Math.max(1, window.devicePixelRatio || 1)
        const origin = this.getViewportOriginInScreenCssPx()
        const x = Math.round((origin.x + rect.left) * dpr)
        const y = Math.round((origin.y + rect.top) * dpr)
        const width = Math.max(0, Math.round(rect.width * dpr))
        const height = Math.max(0, Math.round(rect.height * dpr))
        return { x, y, width, height }
    }

    getElement(index: number): HTMLElement | null {
        const el = this.elementMap.get(index)
        if (!el) return null
        // Verify element is still connected to the DOM
        if (!el.isConnected) return null
        return el
    }

    getViewportSummary(): string {
        const inView = Array.from(this.metadata.values())
            .filter(m => m.viewportStatus === 'in-viewport')
            .map(m => m.index)

        const scrollY = window.scrollY
        return `VIEWPORT: Scrolled ${scrollY}px, ${inView.length} elements visible [${inView.join(', ')}]`
    }

    toTextRepresentation(includeViewport = true): string {
        const lines: string[] = []
        const pageHeight = document.documentElement.scrollHeight

        for (const [index, el] of this.elementMap) {
            const tag = el.tagName.toLowerCase()
            const type = el.getAttribute('type')
            const tagDisplay = type ? `${tag}[type="${type}"]` : tag

            const parts: string[] = [`[${index}] ${tagDisplay}`]

            // Add text content (truncated)
            const text = this.getDisplayText(el).trim()
            if (text) {
                parts.push(`"${text.substring(0, 60)}"`)
            }

            // Add key attributes
            const id = el.getAttribute('id')
            if (id) parts.push(`id="${id}"`)

            const ariaLabel = el.getAttribute('aria-label')
            if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`)

            const href = el.getAttribute('href')
            if (href) parts.push(`href="${href.substring(0, 80)}"`)

            const placeholder = el.getAttribute('placeholder')
            if (placeholder) parts.push(`placeholder="${placeholder}"`)

            const name = el.getAttribute('name')
            if (name) parts.push(`name="${name}"`)

            const role = el.getAttribute('role')
            if (role) parts.push(`role="${role}"`)

            const accessibleName = this.getAccessibleName(el)
            if (accessibleName) {
                parts.push(`a11y-name="${accessibleName.substring(0, 80)}"`)
            }

            // Add parent context
            const parent = el.parentElement
            if (parent && parent.tagName !== 'BODY' && parent.tagName !== 'HTML') {
                const parentTag = parent.tagName.toLowerCase()
                const parentId = parent.getAttribute('id')
                if (parentId) {
                    parts.push(`in-${parentTag}#${parentId}`)
                } else {
                    parts.push(`in-${parentTag}`)
                }
            }

            const contextPath = this.getContextPath(el)
            if (contextPath) {
                parts.push(`path="${contextPath}"`)
            }

            const rolePath = this.getRolePath(el)
            if (rolePath) {
                parts.push(`role-path="${rolePath}"`)
            }

            // Add viewport-relative bounding box to support VLM->DOM IoU matching.
            if (this.metadata.has(index)) {
                const meta = this.metadata.get(index)!
                const x = Math.max(0, Math.round(meta.rect.left))
                const y = Math.max(0, Math.round(meta.rect.top))
                const width = Math.max(0, Math.round(meta.rect.width))
                const height = Math.max(0, Math.round(meta.rect.height))
                parts.push(`bbox="${x},${y},${width},${height}"`)

                // Desktop/screen-space box in physical pixels for full-screen captures.
                const screenBox = this.getScreenBBox(meta.rect)
                parts.push(`screen-bbox="${screenBox.x},${screenBox.y},${screenBox.width},${screenBox.height}"`)
            }

            // Add position hint (page location)
            if (this.metadata.has(index)) {
                const meta = this.metadata.get(index)!
                const elementTop = meta.rect.top + window.scrollY
                const percentDown = (elementTop / pageHeight) * 100

                if (percentDown < 33) {
                    parts.push('[TOP-SECTION]')
                } else if (percentDown < 66) {
                    parts.push('[MID-SECTION]')
                } else {
                    parts.push('[BOTTOM-SECTION]')
                }
            }

            // Add viewport annotation
            if (includeViewport && this.metadata.has(index)) {
                const meta = this.metadata.get(index)!
                if (meta.viewportStatus === 'in-viewport') {
                    parts.push('[VISIBLE]')
                } else if (meta.viewportStatus === 'below-fold') {
                    parts.push('[BELOW-SCROLL]')
                }
            }

            lines.push(parts.join(' '))
        }
        return lines.join('\n')
    }

    private getDisplayText(el: HTMLElement): string {
        const chunks: string[] = []

        let direct = ''
        for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
                direct += node.textContent ?? ''
            }
        }

        if (direct.trim()) {
            chunks.push(direct)
        }

        // Include first-level child text to better represent nested labels (e.g. <a><span>Label</span></a>)
        const firstLevelText: string[] = []
        for (const child of Array.from(el.children)) {
            const childText = child.textContent?.trim()
            if (!childText) continue
            firstLevelText.push(childText)
            if (firstLevelText.length >= 2) break
        }
        if (firstLevelText.length > 0) {
            chunks.push(firstLevelText.join(' '))
        }

        // If still no useful text, fall back to full textContent
        if (chunks.join(' ').trim().length === 0 && el.textContent) {
            chunks.push(el.textContent)
        }

        return chunks
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 120)
    }

    private getAccessibleName(el: HTMLElement): string {
        const ariaLabel = el.getAttribute('aria-label')?.trim()
        if (ariaLabel) return ariaLabel

        const labelledBy = el.getAttribute('aria-labelledby')
        if (labelledBy) {
            const ids = labelledBy.split(/\s+/).filter(Boolean)
            const labelledText = ids
                .map(id => document.getElementById(id)?.textContent?.trim() || '')
                .filter(Boolean)
                .join(' ')
                .trim()
            if (labelledText) return labelledText
        }

        const title = el.getAttribute('title')?.trim()
        if (title) return title

        const value = el.getAttribute('value')?.trim()
        if (value) return value

        return this.getDisplayText(el)
    }

    private getContextPath(el: HTMLElement): string {
        const segments: string[] = []
        let cursor: HTMLElement | null = el
        let depth = 0
        while (cursor && depth < 4) {
            const tag = cursor.tagName.toLowerCase()
            if (tag === 'html' || tag === 'body') break
            const id = cursor.id ? `#${cursor.id}` : ''
            const dataTestId = cursor.getAttribute('data-testid')
            const testHint = dataTestId ? `[data-testid=${dataTestId}]` : ''
            segments.unshift(`${tag}${id}${testHint}`)
            cursor = cursor.parentElement
            depth += 1
        }
        return segments.join(' > ')
    }

    private getRolePath(el: HTMLElement): string {
        const segments: string[] = []
        let cursor: HTMLElement | null = el
        let depth = 0
        while (cursor && depth < 4) {
            const role = cursor.getAttribute('role') || cursor.tagName.toLowerCase()
            segments.unshift(role)
            cursor = cursor.parentElement
            depth += 1
        }
        return segments.join(' > ')
    }

    isStale(): boolean {
        for (const el of this.elementMap.values()) {
            if (!el.isConnected) return true
        }
        return false
    }

    get size(): number {
        return this.elementMap.size
    }

    /**
     * Get all visible elements with their metadata.
     * Used for VLM bounding box mapping via IoU.
     */
    getVisibleElements(): Array<{ index: number; element: HTMLElement; rect: DOMRect }> {
        const results: Array<{ index: number; element: HTMLElement; rect: DOMRect }> = []

        for (const [index, meta] of this.metadata) {
            if (meta.viewportStatus === 'in-viewport') {
                results.push({
                    index,
                    element: meta.element,
                    rect: meta.rect
                })
            }
        }

        return results
    }

    /**
     * Get all indexed elements with their metadata (visible and non-visible).
     * Used for VLM bounding box mapping when visible elements don't match.
     */
    getAllElements(): Array<{ index: number; element: HTMLElement; rect: DOMRect }> {
        const results: Array<{ index: number; element: HTMLElement; rect: DOMRect }> = []

        for (const [index, el] of this.elementMap) {
            const rect = el.getBoundingClientRect()
            results.push({ index, element: el, rect })
        }

        return results
    }
}
