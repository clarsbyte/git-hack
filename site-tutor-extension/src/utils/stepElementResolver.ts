import { isElementHidden, isInteractiveElement } from './domSanitizer'

type KeywordSet = {
    strong: string[]
    weak: string[]
    hasSignal: boolean
}

const STOP_WORDS = new Set([
    'click', 'press', 'select', 'choose', 'open', 'go', 'navigate', 'enter', 'type',
    'fill', 'complete', 'continue', 'next', 'previous', 'back', 'button', 'link',
    'the', 'a', 'an', 'to', 'for', 'on', 'of', 'and', 'or', 'with', 'this', 'that',
    'it', 'its', 'your', 'you', 'from', 'in', 'new', 'page', 'section', 'tab'
])

const extractKeywords = (raw: string): KeywordSet => {
    const strong = new Set<string>()
    const weak = new Set<string>()
    const lower = raw.toLowerCase()

    const quotedMatches = raw.match(/['"]([^'"]+)['"]/g)
    if (quotedMatches) {
        quotedMatches.forEach(match => {
            const cleaned = match.replace(/['"]/g, '').trim().toLowerCase()
            if (cleaned) strong.add(cleaned)
        })
    }

    const strongPhrases = [
        'add to bag',
        'add to cart',
        'buy',
        'checkout',
        'sign in',
        'continue as guest',
        'shipping',
        'delivery',
        'payment'
    ]
    strongPhrases.forEach(phrase => {
        if (lower.includes(phrase)) {
            strong.add(phrase)
        }
    })

    const tokens = lower.match(/[a-z0-9]+/g) || []
    tokens.forEach(token => {
        if (token.length < 3) return
        if (STOP_WORDS.has(token)) return
        weak.add(token)
    })

    return {
        strong: Array.from(strong),
        weak: Array.from(weak),
        hasSignal: strong.size > 0 || weak.size > 1,
    }
}

const getElementText = (el: Element): string => {
    const text = [
        el.textContent ?? '',
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('title') ?? '',
        el.getAttribute('value') ?? '',
        el.getAttribute('placeholder') ?? '',
        el.getAttribute('name') ?? '',
        el.getAttribute('id') ?? '',
        el.getAttribute('data-testid') ?? '',
        el.getAttribute('data-test') ?? '',
        el.getAttribute('data-qa') ?? '',
    ]
    return text.join(' ').toLowerCase()
}

const isVisible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false
    if (isElementHidden(el)) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
}

const scoreElement = (el: Element, keywords: KeywordSet): number => {
    if (!isVisible(el)) return 0

    const searchText = getElementText(el)
    let score = 0

    keywords.strong.forEach(keyword => {
        if (searchText.includes(keyword)) {
            score += 60
        }
    })

    keywords.weak.forEach(keyword => {
        if (searchText.includes(keyword)) {
            score += 10
        }
    })

    if (isInteractiveElement(el)) {
        score += 10
    }

    return score
}

export const elementMatchesInstruction = (el: Element, instruction: string): boolean => {
    const keywords = extractKeywords(instruction)
    if (!keywords.hasSignal) return true

    const searchText = getElementText(el)
    if (keywords.strong.length > 0) {
        return keywords.strong.some(keyword => searchText.includes(keyword))
    }

    return scoreElement(el, keywords) >= 20
}

export const findBestElementByInstruction = (instruction: string): HTMLElement | null => {
    const keywords = extractKeywords(instruction)
    if (!keywords.hasSignal) return null

    const candidates = Array.from(document.querySelectorAll(
        'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"]'
    ))

    let bestElement: HTMLElement | null = null
    let bestScore = 0

    for (const candidate of candidates) {
        if (!(candidate instanceof HTMLElement)) continue
        const score = scoreElement(candidate, keywords)
        if (score <= 0) continue
        if (!bestElement || score > bestScore) {
            bestElement = candidate
            bestScore = score
        }
    }

    if (!bestElement) return null
    if (keywords.strong.length > 0 && bestScore < 60) return null
    if (bestScore < 30) return null
    return bestElement
}
