export type TutorialActionType = 'click' | 'input' | 'wait' | 'navigate'

export interface TutorialStep {
    stepNumber: number
    selector: string
    instruction: string
    actionType: TutorialActionType
    expectedResult?: string
    hint?: string
    elementIndex?: number
}

export interface TutorialPayload {
    title: string
    steps: TutorialStep[]
}

// Extended step record with full action memory
export interface EnhancedStepRecord {
  stepNumber: number
  completed: boolean

  // Exact action taken
  clickedElement?: {
    xpath: string              // Full XPath to element
    selector: string           // CSS selector if available
    elementText: string        // Button text or label
    tagName: string            // e.g., "BUTTON", "A"
  }

  // Page state at action time
  pageState?: {
    url: string                // Full URL after action
    urlHash: string            // URL without query params
    title: string              // Document title
    domHash: string            // Hash of critical DOM elements
    timestamp: number          // When action occurred
  }

  // Verification result
  verification?: {
    method: 'llm' | 'strict' | 'manual'
    isCorrect: boolean
    llmResponse?: string       // LLM explanation
    errorReason?: string       // Why it failed
    verifiedAt: number         // Timestamp
  }

  // Error tracking
  error?: {
    message: string            // User-facing error message
    expectedAction: string     // What should have happened
    actualAction: string       // What actually happened
    canRetry: boolean          // Whether step can be retried
  }
}

// Route history for entire tutorial session
export interface RouteHistory {
  tutorialFingerprint: string
  sessionId: string
  actions: ActionHistoryEntry[]
  currentBranchPath: string[]  // e.g., ["step1-primary", "step2-alt-button-A"]
}

export interface ActionHistoryEntry {
  stepNumber: number
  action: 'click' | 'input' | 'navigate' | 'wait'
  elementXPath: string
  elementSelector: string
  pageUrlBefore: string
  pageUrlAfter: string
  domHashBefore: string
  domHashAfter: string
  timestamp: number
  verificationPassed: boolean
}

// Error interface for step verification failures
export interface StepError {
  message: string
  expectedAction: string
  actualAction: string
  canRetry: boolean
}
