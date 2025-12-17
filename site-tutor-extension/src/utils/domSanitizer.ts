export interface SimplifiedNode {
    tag: string
    attributes: Record<string, string>
    text?: string
    children?: SimplifiedNode[]
}

const IGNORED_TAGS = new Set(['script', 'style', 'meta', 'link', 'noscript', 'template'])
const SEMANTIC_TAGS = new Set([
    'header', 'footer', 'nav', 'main', 'section', 'article', 'aside', 'form',
    'label', 'fieldset', 'legend', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'ol', 'ul', 'li', 'details', 'summary', 'figure', 'figcaption', 'dialog',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
])

const attributeAllowList = new Set([
    'id', 'role', 'href', 'name', 'type', 'aria-label', 'aria-describedby',
    'aria-controls', 'placeholder', 'title', 'for', 'value'
])

const isBrowser = typeof window !== 'undefined'

const isElementHidden = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false
    if (el.hidden) return true
    if (el.getAttribute('aria-hidden') === 'true') return true
    const style = isBrowser ? window.getComputedStyle?.(el) : null
    if (!style) return false
    return (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        style.height === '0px' ||
        style.width === '0px'
    )
}

export const isInteractiveElement = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    const interactiveTags = new Set([
        'button', 'a', 'input', 'select', 'textarea', 'summary', 'details'
    ])

    if (interactiveTags.has(tag)) return true
    if ((el as HTMLElement).isContentEditable) return true
    if (el.getAttribute('role')?.includes('button')) return true
    if (tag === 'div' || tag === 'span') {
        const role = el.getAttribute('role')
        if (role && ['button', 'link', 'checkbox', 'tab', 'switch'].includes(role)) {
            return true
        }
    }
    return false
}

export const isSemanticElement = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    if (SEMANTIC_TAGS.has(tag)) return true
    if (tag === 'input') return true
    if (el.getAttribute('role')) return true
    if (el.getAttribute('aria-label')) return true
    return false
}

const hasStableIdentifier = (el: Element): boolean => {
    if (el.id) return true
    const role = el.getAttribute('role')
    if (role) return true
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel) return true
    const dataAttributes = Array.from(el.attributes).some(attr => attr.name.startsWith('data-'))
    if (dataAttributes) return true
    if (el.getAttribute('name')) return true
    return false
}

const redactSensitiveValue = (el: Element, attrName: string, attrValue: string): string => {
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && attrName === 'value') {
        if (attrValue.trim()) {
            return '[REDACTED]'
        }
    }
    return attrValue
}

const extractAttributes = (el: Element): Record<string, string> => {
    const attrs: Record<string, string> = {}
    Array.from(el.attributes).forEach(attr => {
        const { name, value } = attr
        const isDataAttr = name.startsWith('data-')
        if (isDataAttr || attributeAllowList.has(name)) {
            attrs[name] = redactSensitiveValue(el, name, value)
        }
    })

    if ((el as HTMLElement).dataset) {
        Object.entries((el as HTMLElement).dataset).forEach(([key, value]) => {
            if (typeof value === 'string') {
                attrs[`data-${key}`] = value
            }
        })
    }

    return attrs
}

const shouldKeepElement = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    if (IGNORED_TAGS.has(tag)) return false
    if (isElementHidden(el)) return false
    if (isInteractiveElement(el)) return true
    if (isSemanticElement(el)) return true
    if (hasStableIdentifier(el)) return true
    const text = el.textContent?.trim()
    if (text && text.length > 0 && text.length <= 140) return true
    return false
}

const simplifyElement = (el: Element, depth = 0): SimplifiedNode[] => {
    if (depth > 50) return []
    const tag = el.tagName.toLowerCase()
    if (IGNORED_TAGS.has(tag)) return []
    if (isElementHidden(el)) return []

    const children: SimplifiedNode[] = []

    Array.from(el.children).forEach(child => {
        children.push(...simplifyElement(child, depth + 1))
    })

    const host = el as HTMLElement & { shadowRoot?: ShadowRoot | null }
    if (host.shadowRoot) {
        children.push(...getSimplifiedDom(host.shadowRoot))
    }

    const shouldKeep = shouldKeepElement(el)

    if (!shouldKeep) {
        return children
    }

    const textContent = el.textContent?.replace(/\s+/g, ' ').trim() || ''
    const node: SimplifiedNode = {
        tag,
        attributes: extractAttributes(el)
    }

    if (textContent && textContent.length <= 160) {
        node.text = textContent
    }

    if (children.length > 0) {
        node.children = children
    }

    return [node]
}

export const traverseShadowDOM = (root: Document | ShadowRoot): Element[] => {
    const elements: Element[] = []
    const process = (node: Element) => {
        elements.push(node)
        const shadowHost = node as HTMLElement & { shadowRoot?: ShadowRoot | null }
        if (shadowHost.shadowRoot) {
            Array.from(shadowHost.shadowRoot.children).forEach(child => process(child))
        }
        Array.from(node.children).forEach(child => process(child))
    }

    Array.from(root.children).forEach(child => process(child))
    return elements
}

export const getSimplifiedDom = (root?: Document | ShadowRoot): SimplifiedNode[] => {
    const targetRoot = root ?? (isBrowser ? document : undefined)
    if (!targetRoot) return []
    const simplified: SimplifiedNode[] = []
    Array.from(targetRoot.children).forEach(child => {
        simplified.push(...simplifyElement(child))
    })
    return simplified
}
