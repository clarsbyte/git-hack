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
