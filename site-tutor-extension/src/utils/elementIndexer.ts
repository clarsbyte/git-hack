import { isElementHidden, isInteractiveElement, IGNORED_TAGS } from './domSanitizer'

const MAX_ELEMENTS = 200

export class ElementIndexer {
    private elementMap: Map<number, HTMLElement> = new Map()
    private nextIndex = 0

    indexPage(root?: Document | ShadowRoot): void {
        this.elementMap.clear()
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

    toTextRepresentation(): string {
        const lines: string[] = []
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
