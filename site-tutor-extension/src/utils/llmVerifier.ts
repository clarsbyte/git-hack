/**
 * LLMVerifier - Validates tutorial step outcomes using LLM
 * Sends page state to GPT-4o-mini to verify if action achieved expected result
 */

export interface VerificationRequest {
  stepNumber: number
  stepInstruction: string
  expectedResult: string
  actualPageState: {
    url: string
    title: string
    visibleElements: string[]      // Button texts, headings, etc.
    clickedElement: string          // What user actually clicked
  }
}

export interface VerificationResponse {
  isCorrect: boolean
  confidence: number                // 0-1 scale
  reason: string                    // Explanation
  suggestedAction?: 'continue' | 'retry' | 'abort'
}

export class LLMVerifier {
  private apiKey: string
  private model: string = 'gpt-4o-mini'  // Fast, cheap model
  private timeout: number = 5000         // 5 second timeout
  private cache: Map<string, VerificationResponse> = new Map()

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  /**
   * Verify if step outcome matches expected result
   * Uses LLM to intelligently compare expected vs actual state
   */
  async verifyStepOutcome(
    request: VerificationRequest
  ): Promise<VerificationResponse> {
    // Check cache first
    const cacheKey = this.getCacheKey(request)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      return cached
    }

    try {
      const prompt = this.buildVerificationPrompt(request)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeout)

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'system',
            content: 'You verify if a user action in a tutorial achieved the expected outcome. Respond with JSON only.'
          }, {
            role: 'user',
            content: prompt
          }],
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 200
        }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      const result = JSON.parse(data.choices[0].message.content)

      const verificationResult: VerificationResponse = {
        isCorrect: result.isCorrect ?? false,
        confidence: result.confidence ?? 0.5,
        reason: result.reason || 'No explanation provided',
        suggestedAction: result.suggestedAction || (result.isCorrect ? 'continue' : 'retry')
      }

      // Cache the result
      this.cache.set(cacheKey, verificationResult)

      return verificationResult

    } catch (error) {
      console.error('LLM verification failed:', error)

      // Fallback: return uncertain result
      return {
        isCorrect: false,
        confidence: 0.3,
        reason: `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}. Please verify manually.`,
        suggestedAction: 'retry'
      }
    }
  }

  /**
   * Build verification prompt for LLM
   */
  private buildVerificationPrompt(req: VerificationRequest): string {
    return `
Tutorial Step #${req.stepNumber}: "${req.stepInstruction}"
Expected Result: "${req.expectedResult}"

User Action Taken:
- Clicked: "${req.actualPageState.clickedElement}"
- Current Page URL: "${req.actualPageState.url}"
- Page Title: "${req.actualPageState.title}"
- Visible Elements: ${req.actualPageState.visibleElements.slice(0, 15).join(', ')}

Question: Did the user action achieve the expected result?

Respond with JSON:
{
  "isCorrect": true/false,
  "confidence": 0.0-1.0,
  "reason": "explanation of why it matches or doesn't match",
  "suggestedAction": "continue" | "retry" | "abort"
}
    `.trim()
  }

  /**
   * Generate cache key for verification request
   */
  private getCacheKey(req: VerificationRequest): string {
    return `${req.stepNumber}-${req.expectedResult}-${req.actualPageState.url}-${req.actualPageState.title}`
  }

  /**
   * Extract visible elements from page for verification
   * Static method that can be called without instance
   */
  static extractVisibleElements(): string[] {
    const elements: string[] = []

    // Get all visible buttons
    document.querySelectorAll('button, a, [role="button"]').forEach(el => {
      if (this.isVisible(el)) {
        const text = el.textContent?.trim()
        if (text && text.length > 0) {
          elements.push(`Button: "${text.substring(0, 50)}"`)
        }
      }
    })

    // Get headings
    document.querySelectorAll('h1, h2, h3').forEach(el => {
      if (this.isVisible(el)) {
        const text = el.textContent?.trim()
        if (text && text.length > 0) {
          elements.push(`Heading: "${text.substring(0, 50)}"`)
        }
      }
    })

    // Get visible input labels
    document.querySelectorAll('label').forEach(el => {
      if (this.isVisible(el)) {
        const text = el.textContent?.trim()
        if (text && text.length > 0) {
          elements.push(`Label: "${text.substring(0, 50)}"`)
        }
      }
    })

    // Limit to avoid huge prompts
    return elements.slice(0, 20)
  }

  /**
   * Check if element is visible on screen
   */
  private static isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    )
  }

  /**
   * Clear verification cache
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Test API key validity
   */
  async testApiKey(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)

      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      return response.ok
    } catch {
      return false
    }
  }
}
