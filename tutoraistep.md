# Tutorial Step Generation Plan

## Overview

Enhance the backend to detect tutorial requests (like "create a new repo") and generate structured step-by-step tutorials using Gemini. The model will analyze the screenshot and DOM tree to create a sequence of actionable steps.

## Architecture Flow

```mermaid
flowchart TD
    A[User: "create a new repo"] --> B[Frontend: Send message + screenshot + DOM]
    B --> C[Backend: Detect tutorial request]
    C --> D[Backend: Build enhanced prompt with DOM context]
    D --> E[Gemini: Generate tutorial steps]
    E --> F[Backend: Parse and validate steps]
    F --> G[Return tutorial object to frontend]
    G --> H[Frontend: Display TutorialController]
```

## Implementation Details

### 1. Update Backend Models

**File: [backend/main.py](backend/main.py)**

Add tutorial-related models to support the new response format:

- Create `TutorialStep` model with fields: `stepNumber`, `selector`, `instruction`, `actionType`, `expectedResult`, `hint`
- Create `TutorialPayload` model with fields: `title`, `steps`
- Update `ChatResponse` to include optional `tutorial: Optional[TutorialPayload]` field

### 2. Accept DOM Tree in Request

**File: [backend/main.py](backend/main.py)**

Modify the `/chat` endpoint to accept DOM tree data:

- Add `dom: Optional[str] = Form(None)` parameter to the endpoint
- Parse the JSON DOM tree if provided
- Include DOM context in the prompt sent to Gemini

### 3. Tutorial Request Detection

**File: [backend/main.py](backend/main.py)**

Add logic to detect when a user wants a tutorial:

- Check for tutorial keywords: "create", "how to", "tutorial", "guide me", "step by step", "walk me through"
- Common patterns: "create a new repo", "how to create repository", "tutorial for X"
- Set `is_tutorial_request` flag when detected

### 4. Enhanced Prompt for Tutorial Generation

**File: [backend/main.py](backend/main.py)**

When `is_tutorial_request` is true, modify the prompt to:

- Instruct Gemini to generate a multi-step tutorial sequence
- Provide the DOM tree structure for context
- Specify the required JSON format with tutorial object
- Include guidelines for:
  - Step sequencing (logical order)
  - Action type selection (click, input, wait, navigate)
  - Selector generation (using DOM tree + screenshot)
  - Expected results for each step
  - Optional hints for difficult steps

### 5. Response Parsing and Validation

**File: [backend/main.py](backend/main.py)**

Update response parsing to:

- Extract `tutorial` object from Gemini's JSON response
- Validate that steps array exists and has at least 2 steps
- Ensure each step has required fields (stepNumber, selector, instruction, actionType)
- Fallback to highlights-only response if tutorial generation fails

### 6. Prompt Engineering Strategy

The prompt should instruct Gemini to:

1. **Analyze the task**: Understand what the user wants to accomplish
2. **Break into steps**: Divide the task into 3-8 discrete, sequential steps
3. **Identify elements**: Use DOM tree + screenshot to find exact selectors
4. **Assign actions**: Determine actionType (click, input, wait, navigate) for each step
5. **Write instructions**: Clear, concise instructions for each step
6. **Set expectations**: Describe what should happen after each step

## Key Considerations

- **DOM Tree Usage**: The DOM tree provides structural context, but selectors should still be validated against the screenshot
- **Selector Priority**: Follow existing selector priority rules (ID > data attributes > structural > class names)
- **Step Count**: Tutorials should have 3-8 steps (too few = not helpful, too many = overwhelming)
- **Action Types**: 
  - `click`: For buttons, links, checkboxes
  - `input`: For text fields, textareas
  - `wait`: For page transitions, loading states
  - `navigate`: For URL changes, route changes
- **Error Handling**: If tutorial generation fails, gracefully fall back to highlights-only mode

## Example Response Format

```json
{
  "text": "I'll guide you through creating a new GitHub repository step by step.",
  "highlights": [],
  "tutorial": {
    "title": "Create a New GitHub Repository",
    "steps": [
      {
        "stepNumber": 1,
        "selector": "header button[aria-label*='New']",
        "instruction": "Click the 'New' button in the top right corner",
        "actionType": "click",
        "expectedResult": "Repository creation form appears",
        "hint": "Look for a green button with a plus icon"
      },
      {
        "stepNumber": 2,
        "selector": "input[name='repository[name]']",
        "instruction": "Enter a name for your repository",
        "actionType": "input",
        "expectedResult": "Repository name field is filled"
      }
    ]
  }
}
```

## Testing Strategy

- Test with "create a new repo" on GitHub
- Test with "how to login" on various sites
- Verify selectors work on actual pages
- Ensure fallback to highlights works if tutorial generation fails