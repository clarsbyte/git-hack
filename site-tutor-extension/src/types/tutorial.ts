export type TutorialActionType = 'click' | 'input' | 'wait' | 'navigate' | 'scroll' | 'observe'

export interface TutorialStep {
    stepNumber: number
    selector: string
    instruction: string
    actionType: TutorialActionType
    expectedResult?: string
    selectionReason?: string
    isTerminal?: boolean
    elementIndex?: number
    scrollTarget?: number  // For 'scroll' actionType - element index to scroll to
}

export interface TutorialPayload {
    title: string
    steps: TutorialStep[]
    plan?: TutorialPlan
    planStepOffset?: number
}

// Abstract step in the high-level plan - NO element indices, page-agnostic
export interface PlanStep {
    stepNumber: number
    instruction: string
    actionType: TutorialActionType
    expectedResult?: string
    isTerminal?: boolean
    expectsPageChange: boolean
    pageDescription?: string
    scrollTarget?: number  // For 'scroll' actionType - element index to scroll to
}

// Highlight with a reference back to which plan step it belongs to
export interface PlanHighlight {
    elementIndex?: number
    explanation: string
    selector?: string
    planStepNumber?: number
}

// Full high-level plan returned by the backend
export interface TutorialPlan {
    title: string
    totalSteps: number
    planSteps: PlanStep[]
    currentPageHighlights: PlanHighlight[]
    currentPageRange: { startIndex: number; endIndex: number }
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
  action: 'click' | 'input' | 'navigate' | 'wait' | 'observe'
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
