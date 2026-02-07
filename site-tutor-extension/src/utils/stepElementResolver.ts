import { isElementHidden, isInteractiveElement } from './domSanitizer'
import { detectElementWithVLM, isVLMAvailable } from './vlmDetector'
import { ElementIndexer } from './elementIndexer'

type KeywordSet = {
    strong: string[]
    weak: string[]
    hasSignal: boolean
    raw: string
}

type ExpectedControl = 'input' | 'button' | 'link' | 'any'

// Synonym map for common UI term equivalences (Fix 1: semantic fallback)
const SYNONYM_MAP: Record<string, string[]> = {
    proceed: ['next', 'continue', 'forward'],
    next: ['proceed', 'continue', 'forward'],
    continue: ['next', 'proceed', 'forward'],
    submit: ['send', 'done', 'confirm', 'apply'],
    send: ['submit', 'done', 'confirm'],
    cancel: ['close', 'dismiss', 'discard', 'nevermind'],
    close: ['cancel', 'dismiss', 'exit'],
    save: ['apply', 'confirm', 'done', 'update'],
    confirm: ['ok', 'yes', 'accept', 'approve', 'save', 'submit'],
    ok: ['confirm', 'yes', 'accept', 'okay'],
    delete: ['remove', 'trash', 'discard', 'erase'],
    remove: ['delete', 'trash', 'discard'],
    edit: ['modify', 'change', 'update'],
    update: ['edit', 'modify', 'change', 'save'],
    search: ['find', 'lookup', 'filter'],
    find: ['search', 'lookup', 'filter'],
    login: ['signin', 'sign', 'log'],
    signin: ['login', 'sign', 'log'],
    signup: ['register', 'create', 'join'],
    register: ['signup', 'create', 'join'],
    buy: ['purchase', 'order', 'checkout', 'add'],
    purchase: ['buy', 'order', 'checkout'],
    add: ['create', 'new', 'insert', 'plus'],
    create: ['add', 'new', 'make'],
    settings: ['preferences', 'options', 'config'],
    preferences: ['settings', 'options', 'config'],
    back: ['return', 'previous', 'go back'],
    previous: ['back', 'return', 'prior'],
    start: ['begin', 'launch', 'go'],
    begin: ['start', 'launch', 'go'],
    finish: ['complete', 'done', 'end'],
    complete: ['finish', 'done', 'end'],
    accept: ['agree', 'confirm', 'ok', 'yes'],
    decline: ['reject', 'deny', 'no'],
    expand: ['show', 'open', 'more', 'details'],
    collapse: ['hide', 'less', 'close'],
    download: ['export', 'save'],
    upload: ['import', 'attach'],
}

/**
 * Expand a set of keywords with synonyms.
 * Returns the original keywords plus any synonym matches.
 */
const expandWithSynonyms = (keywords: string[]): string[] => {
    const expanded = new Set(keywords)
    for (const kw of keywords) {
        const synonyms = SYNONYM_MAP[kw]
        if (synonyms) {
            for (const syn of synonyms) {
                expanded.add(syn)
            }
        }
    }
    return Array.from(expanded)
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
        hasSignal: strong.size > 0 || weak.size > 0,
        raw: lower.trim(),
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

const inferExpectedControl = (instruction: string): ExpectedControl => {
    const lower = instruction.toLowerCase()
    if (/(type|enter|fill|input|search|email|password|name|address|zip|phone)/.test(lower)) {
        return 'input'
    }
    if (/(open|go to|navigate|visit| link| tab|menu item)/.test(lower)) {
        return 'link'
    }
    if (/(click|tap|press|buy|add to|checkout|submit|continue|select|choose|pick)/.test(lower)) {
        return 'button'
    }
    return 'any'
}

const inferTopicFromInstruction = (instruction: string): string => {
    const tokens = instruction.toLowerCase().match(/[a-z0-9]+/g) ?? []
    const localStop = new Set([
        ...Array.from(STOP_WORDS),
        'model', 'models', 'item', 'product', 'products', 'option', 'options',
        'buy', 'purchase', 'order', 'choose', 'select', 'pick'
    ])
    const filtered = tokens.filter(token => token.length >= 3 && !localStop.has(token))
    return filtered[0] || ''
}

const isModelSelectionInstruction = (instruction: string): boolean => {
    const lower = instruction.toLowerCase()
    return lower.includes('model') && (lower.includes('select') || lower.includes('choose') || lower.includes('pick'))
}

const isSpecificModelLabel = (label: string, topic: string): boolean => {
    const lower = label.trim().toLowerCase()
    if (!lower) return false
    if (topic && !lower.includes(topic)) return false
    const hasNumber = /\b\d+\b/.test(lower)
    const hasVariant = ['pro max', 'pro', 'plus', 'air', 'mini', 'ultra', 'max', 'se'].some(v => lower.includes(v))
    return hasNumber || hasVariant
}

const isInputControl = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    const role = (el.getAttribute('role') || '').toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select' || ['textbox', 'searchbox', 'combobox'].includes(role)
}

const isButtonControl = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    const role = (el.getAttribute('role') || '').toLowerCase()
    if (tag === 'button') return true
    if (tag === 'input') {
        const type = (el.getAttribute('type') || '').toLowerCase()
        return ['button', 'submit', 'reset'].includes(type)
    }
    return role === 'button'
}

const isLinkControl = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    const role = (el.getAttribute('role') || '').toLowerCase()
    return tag === 'a' || role === 'link' || !!el.getAttribute('href')
}

/**
 * Get the primary visible text of an element (just direct text, not all attributes).
 * Used for specificity comparison.
 */
const getPrimaryText = (el: Element): string => {
    const text = el.textContent?.trim() ?? ''
    if (text) return text.toLowerCase()
    return (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').toLowerCase()
}

/**
 * Compute specificity ratio between query and element text.
 * Returns 0-1 where 1 = perfect match (all query words present, no surplus).
 * Penalizes elements with more words than the query.
 */
const computeSpecificity = (queryText: string, elementText: string): number => {
    const queryWords = queryText.toLowerCase().match(/[a-z0-9]+/g) || []
    const elementWords = elementText.toLowerCase().match(/[a-z0-9]+/g) || []

    if (queryWords.length === 0 || elementWords.length === 0) return 0

    // Count how many query words appear in element text
    const matchedCount = queryWords.filter(qw =>
        elementWords.some(ew => ew === qw || ew.includes(qw) || qw.includes(ew))
    ).length

    // If not all query words matched, low specificity
    if (matchedCount < queryWords.length) return matchedCount / (queryWords.length * 2)

    // All query words matched — penalize surplus element words
    // "iphone" (1) vs "iphone" (1) = 1.0
    // "iphone" (1) vs "iphone pro" (2) = 0.5
    // "iphone pro" (2) vs "iphone pro" (2) = 1.0
    // "iphone pro" (2) vs "iphone pro max" (3) = 0.67
    return queryWords.length / Math.max(queryWords.length, elementWords.length)
}

const isVisible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false
    if (isElementHidden(el)) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
}

const scoreElement = (el: Element, keywords: KeywordSet, expected: ExpectedControl, rawInstruction?: string): number => {
    if (!isVisible(el)) return 0

    const searchText = getElementText(el)
    let score = 0
    let weakMatchCount = 0

    keywords.strong.forEach(keyword => {
        if (searchText.includes(keyword)) {
            score += 60
        }
    })

    keywords.weak.forEach(keyword => {
        if (searchText.includes(keyword)) {
            score += 10
            weakMatchCount += 1
        }
    })

    // Guardrail: if the instruction has explicit keywords but none match,
    // try synonym expansion before rejecting.
    if (keywords.weak.length > 0 && weakMatchCount === 0 && keywords.strong.length === 0) {
        const synonymExpanded = expandWithSynonyms(keywords.weak)
        const synonymMatches = synonymExpanded.filter(kw => !keywords.weak.includes(kw) && searchText.includes(kw))
        if (synonymMatches.length === 0) {
            return 0
        }
        // Give partial credit for synonym matches (less than direct matches)
        score += synonymMatches.length * 6
    }

    if (isInteractiveElement(el)) {
        score += 10
    }

    if (expected === 'input') {
        if (isInputControl(el)) score += 90
        else score -= 70
    } else if (expected === 'button') {
        if (isButtonControl(el)) score += 85
        else if (isLinkControl(el)) score += 45
        else score -= 45
    } else if (expected === 'link') {
        if (isLinkControl(el)) score += 85
        else if (isButtonControl(el)) score += 20
        else score -= 45
    }

    if (rawInstruction && isModelSelectionInstruction(rawInstruction)) {
        const topic = inferTopicFromInstruction(rawInstruction)
        const primaryText = getPrimaryText(el).trim().toLowerCase()
        if (topic) {
            if (primaryText === topic) {
                score -= 220
            } else if (isSpecificModelLabel(primaryText, topic)) {
                score += 220
            }
        }
    }

    // Specificity scoring — reward exact matches, penalize surplus text
    if (score > 0 && rawInstruction) {
        const primaryText = getPrimaryText(el)
        const specificity = computeSpecificity(rawInstruction, primaryText)

        const normalizedQuery = rawInstruction.trim()
        const normalizedPrimary = primaryText.trim()

        if (normalizedPrimary === normalizedQuery) {
            // Exact text match — strong bonus
            score += 100
        } else if (normalizedPrimary.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedPrimary)) {
            // Near-exact: one is a prefix of the other
            score += Math.round(50 * specificity)
        } else {
            // Penalize surplus text beyond the query
            const surplusPenalty = Math.round((1 - specificity) * 30)
            score -= surplusPenalty
        }
    }

    return Math.max(0, score)
}

export const elementMatchesInstruction = (el: Element, instruction: string): boolean => {
    const keywords = extractKeywords(instruction)
    if (!keywords.hasSignal) return true
    const expected = inferExpectedControl(instruction)

    const searchText = getElementText(el)
    if (keywords.strong.length > 0) {
        const hasStrongMatch = keywords.strong.some(keyword => searchText.includes(keyword))
        if (!hasStrongMatch) return false

        // Reject elements with extreme surplus text
        const primaryText = getPrimaryText(el)
        const specificity = computeSpecificity(instruction, primaryText)
        return specificity >= 0.3
    }

    return scoreElement(el, keywords, expected, keywords.raw) >= 20
}

/**
 * Find best element using DOM-based matching only.
 * Internal function used by hybrid resolver.
 */
const findBestElementByInstructionDOM = (instruction: string): { element: HTMLElement; confidence: number } | null => {
    const keywords = extractKeywords(instruction)
    if (!keywords.hasSignal) return null
    const expected = inferExpectedControl(instruction)

    const candidates = Array.from(document.querySelectorAll(
        'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"]'
    ))

    let bestElement: HTMLElement | null = null
    let bestScore = 0

    for (const candidate of candidates) {
        if (!(candidate instanceof HTMLElement)) continue
        const score = scoreElement(candidate, keywords, expected, keywords.raw)
        if (score <= 0) continue
        if (!bestElement || score > bestScore) {
            bestElement = candidate
            bestScore = score
        }
    }

    if (!bestElement) return null
    if (keywords.strong.length > 0 && bestScore < 60) return null
    if (bestScore < 30) return null

    // Normalize score to 0-1 range (assume max score ~200)
    const normalizedConfidence = Math.min(bestScore / 200, 1.0)

    return { element: bestElement, confidence: normalizedConfidence }
}

/**
 * Find best element using hybrid DOM + VLM approach.
 *
 * Strategy:
 * 1. Try DOM-based matching first (fast)
 * 2. If confidence < 70%, try VLM as fallback
 * 3. Return best result
 *
 * @param instruction - Natural language instruction
 * @param indexer - Element indexer (required for VLM)
 * @param useVLM - Enable VLM fallback (default: false)
 */
export const findBestElementByInstruction = async (
    instruction: string,
    indexer?: ElementIndexer,
    useVLM: boolean = false
): Promise<HTMLElement | null> => {
    // Phase 1: Try DOM-based matching
    const domResult = findBestElementByInstructionDOM(instruction)

    // If DOM confidence is high enough, use it
    if (domResult && domResult.confidence >= 0.7) {
        console.log(`✅ [Resolver] DOM match confidence: ${domResult.confidence.toFixed(2)}`)
        return domResult.element
    }

    // Phase 2: Try VLM if enabled and confidence is low
    if (useVLM && indexer && domResult && domResult.confidence < 0.7) {
        console.log(`⚠️ [Resolver] DOM confidence low (${domResult.confidence.toFixed(2)}), trying VLM...`)

        try {
            // Check if VLM is available
            const vlmAvailable = await isVLMAvailable()
            if (!vlmAvailable) {
                console.warn('⚠️ [Resolver] VLM not available, using DOM result')
                return domResult.element
            }

            // Detect with VLM
            const vlmResult = await detectElementWithVLM(instruction, indexer)

            if (vlmResult && vlmResult.confidence > domResult.confidence) {
                console.log(`✅ [Resolver] VLM match better: ${vlmResult.confidence.toFixed(2)} vs ${domResult.confidence.toFixed(2)}`)
                return vlmResult.element
            } else {
                console.log(`ℹ️ [Resolver] VLM result not better than DOM, using DOM`)
            }
        } catch (error) {
            console.warn('⚠️ [Resolver] VLM detection failed:', error)
        }
    }

    // Phase 3: Return best available result (DOM or null)
    return domResult?.element ?? null
}

/**
 * Synchronous version of findBestElementByInstruction (DOM-only).
 * Use this when you need immediate results without VLM fallback.
 */
export const findBestElementByInstructionSync = (instruction: string): HTMLElement | null => {
    const result = findBestElementByInstructionDOM(instruction)
    return result?.element ?? null
}
