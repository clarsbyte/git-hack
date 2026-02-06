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
            const text = this.getDirectText(el).trim()
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

    private getDirectText(el: HTMLElement): string {
        let text = ''
        for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent ?? ''
            }
        }
        // If no direct text nodes, fall back to textContent but cap it
        if (!text.trim() && el.textContent) {
            text = el.textContent.substring(0, 80)
        }
        return text.replace(/\s+/g, ' ').trim()
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
}
