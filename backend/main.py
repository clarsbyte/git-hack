import os
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from pydantic import BaseModel
from typing import List, Optional
import json
from dotenv import load_dotenv
from anthropic import Anthropic
from PIL import Image, ImageGrab
import io
import asyncio
from session_manager import SessionManager, TutorialPlanState
import base64

load_dotenv()

def extract_json_object(raw_text: str) -> Optional[str]:
    start = None
    depth = 0
    last_end = None
    for i, ch in enumerate(raw_text):
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    last_end = i + 1
    if start is not None and last_end is not None:
        return raw_text[start:last_end]
    return None

api_key = os.getenv("CLAUDE_API_KEY")
if not api_key:
    print("WARNING: CLAUDE_API_KEY not found in environment variables.")

client = Anthropic(api_key=api_key)
model_name = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
max_output_tokens = int(os.getenv("CLAUDE_MAX_TOKENS", "4096"))

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session Manager for conversation tracking
session_manager = SessionManager()

@app.on_event("startup")
async def startup_event():
    """Periodic cleanup of expired sessions"""
    async def cleanup_task():
        while True:
            await asyncio.sleep(300)  # Every 5 minutes
            session_manager.cleanup_expired_sessions()
    asyncio.create_task(cleanup_task())

class Highlight(BaseModel):
    selector: str = ""
    explanation: str
    elementIndex: Optional[int] = None

class AutomationAction(BaseModel):
    type: str  # "navigate", "click"
    url: Optional[str] = None
    selector: Optional[str] = None

class ChatResponse(BaseModel):
    text: str
    highlights: List[Highlight]
    automation: Optional[AutomationAction] = None
    sessionId: Optional[str] = None  # Session tracking
    reasoning: Optional[str] = None  # AI's thought process for debugging
    tutorialPlan: Optional[dict] = None  # High-level plan for multi-page tutorials

@app.post("/chat", response_model=ChatResponse)
async def chat(
    message: str = Form(...),
    screenshot: Optional[UploadFile] = File(None),
    sessionId: Optional[str] = Form(None),
    dom: Optional[str] = Form(None),
    completionHistory: Optional[str] = Form(None),
    tutorialContext: Optional[str] = Form(None)
):
    print(f"Received message: {message}")

    # Get or create session
    session = session_manager.get_or_create_session(sessionId)
    print(f"Session ID: {session.id}")

    if not api_key:
         return ChatResponse(
             text="Please set your CLAUDE_API_KEY in the backend/.env file to enable the AI agent.",
             highlights=[],
             automation=None,
             sessionId=session.id
         )

    try:
        # Process and store screenshot
        screenshot_image = None
        if screenshot:
            print(f"Processing screenshot: {screenshot.filename}")
            image_bytes = await screenshot.read()
            screenshot_image = Image.open(io.BytesIO(image_bytes))

        # Store user message in session
        session.add_message('user', message, screenshot_image)

        prompt_text = ""
        # Detect if this is a "select" or "highlight" instruction
        is_selection_request = any(keyword in message.lower() for keyword in [
            'select', 'highlight', 'show me', 'point to', 'find', 'where is',
            'click on', 'identify', 'mark', 'circle'
        ])

        selection_instructions = ""
        if is_selection_request:
            selection_instructions = """
IMPORTANT: The user wants you to SELECT/HIGHLIGHT a specific element on the page.
- You MUST return at least one highlight with the element's numeric index from the indexed element list below.
- Cross-reference the screenshot with the indexed element list to find the correct element index.
"""

        # Enhanced instructions for finding multiple elements (like "all buttons")
        multiple_elements_instruction = ""
        if any(keyword in message.lower() for keyword in ['all', 'every', 'each']):
            multiple_elements_instruction = """
CRITICAL: The user wants to find MULTIPLE elements. Generate a SEPARATE highlight entry for EACH distinct element you can identify from the indexed list.
"""

        # Include indexed DOM if provided
        dom_context = ""
        if dom:
            dom_context = f"""
INDEXED ELEMENTS ON THIS PAGE:
Each interactive element has been assigned a numeric index. Reference elements by their index number.
The list below shows: [index] tagName "visible text" key-attributes

{dom}
"""

        # Include completion history if provided
        history_context = ""
        if completionHistory:
            history_context = f"""
PRIOR LEARNING HISTORY:
The user has previously completed these tutorials on this site:
{completionHistory}
You can skip basics they already know and build on prior knowledge.
"""

        # Include tutorial context if provided
        tutorial_context = ""
        if tutorialContext:
            tutorial_context = f"""
CURRENT TUTORIAL CONTEXT:
The user is currently in a step-by-step tutorial. Use this to avoid restarting from step 1.
{tutorialContext}
If the user asks a question while mid-tutorial, continue from the current step and reference the next best action.
"""

        # Treat all requests as tutorial requests by default - always return numbered steps
        is_tutorial_request = True

        tutorial_instruction = ""
        if is_tutorial_request:
            tutorial_instruction = """
CRITICAL: The user is asking for a TUTORIAL or STEP-BY-STEP GUIDE.

You must generate a TWO-TIER response:
1. A HIGH-LEVEL PLAN of ALL steps needed to complete the task (across ALL pages)
2. CURRENT-PAGE HIGHLIGHTS only for steps that can be performed on THIS page (visible in the screenshot/DOM)

REQUIREMENTS:
1. Create a complete plan with ALL steps numbered globally (1, 2, 3, ..., N)
2. For each step, indicate if it will cause a PAGE CHANGE (navigation to a different URL)
3. Identify which steps can be done on the CURRENT page shown in the screenshot
4. Only provide elementIndex highlights for CURRENT-PAGE steps
5. Return steps in the "text" field as numbered lines (ALL steps, not just current page)

Include a "tutorialPlan" object in your response:
{{
  "text": "1. Click the New button\\n2. Enter repository name\\n3. Choose visibility\\n4. Click Create",
  "tutorialPlan": {{
    "title": "Tutorial title here",
    "totalSteps": 4,
    "planSteps": [
      {{"stepNumber": 1, "instruction": "Click the New button", "actionType": "click", "expectsPageChange": true, "pageDescription": "GitHub main page"}},
      {{"stepNumber": 2, "instruction": "Enter repository name", "actionType": "input", "expectsPageChange": false, "pageDescription": "Repository creation form"}},
      {{"stepNumber": 3, "instruction": "Choose visibility", "actionType": "click", "expectsPageChange": false, "pageDescription": "Repository creation form"}},
      {{"stepNumber": 4, "instruction": "Click Create repository", "actionType": "click", "expectsPageChange": true, "pageDescription": "Repository creation form"}}
    ],
    "currentPageHighlights": [
      {{"elementIndex": 5, "explanation": "Click the New button"}}
    ],
    "currentPageRange": {{"startIndex": 0, "endIndex": 0}}
  }},
  "highlights": [
    {{"elementIndex": 5, "explanation": "Click the New button"}}
  ],
  "reasoning": "..."
}}

CRITICAL RULES:
- "planSteps" must include ALL steps for the ENTIRE task, even those on future pages
- "currentPageHighlights" must ONLY include steps doable on THIS page with correct elementIndex from the DOM
- "currentPageRange" indicates which planSteps indices are for the current page (startIndex to endIndex inclusive)
- "highlights" should match "currentPageHighlights" (for backward compatibility)
- "expectsPageChange" should be true if clicking/completing that step will navigate to a new URL
- "actionType" must be one of: "click", "input", "navigate", "wait"
- Use the indexed element list to find EXACT element indices for current-page steps only
"""

        prompt_text = f"""
You are a Site Tutor, an expert web developer and UI guide.
Your goal is to answer the user's question about the website screenshot provided.
You must also identify specific HTML elements on the screen that are relevant to your answer so we can highlight them.

User Question: "{message}"

{tutorial_instruction}

{selection_instructions}

{multiple_elements_instruction}

{dom_context}

{history_context}

{tutorial_context}

AUTOMATION CAPABILITY:
You have the ability to automate actions for the user. When the user expresses frustration, gives up, or asks you to do something for them, you can take control and automate the task.

Detect phrases like "I give up", "Just do it for me", "Can you do it", "You do it", "Help me do this", or any expression of wanting you to take over.

When automation is appropriate, analyze what the user is trying to do and generate the correct automation action:
1. **Navigate to a URL** - Use when user wants to go to a specific page
2. **Click an element** - Use when user wants to click something on the current page

IMPORTANT: Only provide automation when the user clearly wants you to take over.

ELEMENT REFERENCING:
- Each element in the indexed list has a numeric index (e.g. [0], [1], [2]).
- When identifying elements, use the "elementIndex" field with the numeric index from the list.
- Cross-reference the screenshot with the indexed element list to pick the correct index.
- If the indexed list is not available, fall back to a CSS selector in the "selector" field.

Return your response strictly as a JSON object with this format:
{{
  "text": "Your conversational answer here...",
  "highlights": [
    {{ "elementIndex": 5, "explanation": "Brief label for the highlight" }}
  ],
  "automation": null,
  "reasoning": "Explain your thought process: What elements did you see? Why did you pick these specific element indices? How did you match them to each step? This helps debug element selection."
}}

OR for automation:
{{
  "text": "Your conversational answer here...",
  "highlights": [],
  "automation": {{
    "type": "navigate",
    "url": "https://example.com/path"
  }},
  "reasoning": "Your thought process here..."
}}

IMPORTANT: Always include the "reasoning" field with your thought process for debugging.
If no automation is needed, set "automation": null.
If you cannot find an element index, you may include a "selector" field as a CSS selector fallback.
"""

        if not screenshot_image:
            prompt_text += "\n(No screenshot provided, answer based on general web knowledge if possible)"

        # Generate content with Claude
        content_blocks = [{"type": "text", "text": prompt_text}]
        if screenshot_image:
            img_bytes = io.BytesIO()
            screenshot_image.save(img_bytes, format="PNG")
            img_bytes.seek(0)
            content_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.b64encode(img_bytes.getvalue()).decode("utf-8")
                }
            })

        response = client.messages.create(
            model=model_name,
            max_tokens=max_output_tokens,
            messages=[{"role": "user", "content": content_blocks}],
        )

        raw_text = ""
        for block in response.content:
            text_value = getattr(block, "text", None)
            if text_value:
                raw_text += text_value
        print(f"Claude raw response: {raw_text}")
        
        # Clean potential markdown code blocks
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
        
        try:
            parsed = json.loads(raw_text.strip())
        except json.JSONDecodeError:
            extracted = extract_json_object(raw_text)
            if extracted:
                parsed = json.loads(extracted.strip())
            else:
                raise

        # Normalize common key typos from model output
        tutorial_plan_data = parsed.get("tutorialPlan")
        if not isinstance(tutorial_plan_data, dict):
            for alt_key in ("torialPlan", "tutorial_plan", "tutorialplan"):
                alt_value = parsed.get(alt_key)
                if isinstance(alt_value, dict):
                    tutorial_plan_data = alt_value
                    parsed["tutorialPlan"] = tutorial_plan_data
                    break

        if (not isinstance(parsed.get("highlights"), list) or not parsed.get("highlights")) and isinstance(tutorial_plan_data, dict):
            fallback_highlights = tutorial_plan_data.get("currentPageHighlights")
            if isinstance(fallback_highlights, list) and fallback_highlights:
                parsed["highlights"] = fallback_highlights

        bot_response_text = parsed.get("text", "I analyzed the page but couldn't formulate a response.")
        reasoning = parsed.get("reasoning", "")

        # DEBUG: Log reasoning and highlights
        highlights = parsed.get("highlights", [])
        print(f"\n=== AI REASONING DEBUG ===")
        if reasoning:
            print(f"AI Thought Process:\n{reasoning}\n")
        step_lines = [line for line in bot_response_text.splitlines() if line.strip() and line[0].isdigit()]
        print(f"Total steps in text: {len(step_lines)}")
        print(f"Total highlights returned: {len(highlights)}")
        if highlights:
            for i, h in enumerate(highlights):
                print(f"  Step {i+1} → elementIndex={h.get('elementIndex', 'none')}, explanation=\"{h.get('explanation', '')}\"")
        print("========================\n")

        # Store bot message in session
        session.add_message('bot', bot_response_text)

        # Store tutorial plan in session if present
        if tutorial_plan_data and isinstance(tutorial_plan_data, dict):
            plan_steps = tutorial_plan_data.get("planSteps", [])
            session.tutorial_plan = TutorialPlanState(
                plan_steps=plan_steps,
                completed_step_indices=[],
                current_page_start_index=tutorial_plan_data.get("currentPageRange", {}).get("startIndex", 0),
                original_query=message,
                title=tutorial_plan_data.get("title", "Tutorial"),
                total_steps=tutorial_plan_data.get("totalSteps", len(plan_steps)),
            )
            print(f"\n=== TUTORIAL PLAN STORED ===")
            print(f"Title: {session.tutorial_plan.title}")
            print(f"Total steps: {session.tutorial_plan.total_steps}")
            current_range = tutorial_plan_data.get("currentPageRange", {})
            print(f"Current page range: {current_range.get('startIndex', 0)}-{current_range.get('endIndex', 0)}")
            print("===========================\n")

        # Parse automation if present
        automation_data = parsed.get("automation")
        automation = None

        if automation_data and isinstance(automation_data, dict):
            automation = AutomationAction(**automation_data)

        return ChatResponse(
            text=bot_response_text,
            highlights=parsed.get("highlights", []),
            automation=automation,
            sessionId=session.id,
            reasoning=reasoning,
            tutorialPlan=tutorial_plan_data
        )
    except json.JSONDecodeError:
        print(f"Failed to parse JSON: {raw_text}")
        # Try to salvage text if possible, or just fail gracefully
        return ChatResponse(
             text=raw_text,
             highlights=[],
             automation=None,
             sessionId=session.id
        )

    except Exception as e:
        print(f"Error calling Claude: {e}")
        return ChatResponse(
            text=f"I encountered an error analyzing the page: {str(e)}",
            highlights=[],
            automation=None,
            sessionId=session.id
        )


class ContinueTutorialResponse(BaseModel):
    currentPageHighlights: list
    currentPageStepCount: int
    currentPageRange: dict
    reasoning: Optional[str] = None
    sessionId: str


@app.post("/continue-tutorial", response_model=ContinueTutorialResponse)
async def continue_tutorial(
    sessionId: str = Form(...),
    screenshot: Optional[UploadFile] = File(None),
    dom: Optional[str] = Form(None),
    currentPlanStepIndex: int = Form(...),
    completedSteps: str = Form("[]"),
):
    """
    Continue a multi-page tutorial after navigation.
    Re-generates highlights for the new page using the stored plan.
    """
    print(f"\n=== CONTINUE TUTORIAL ===")
    print(f"Session: {sessionId}, resuming from plan step {currentPlanStepIndex}")

    session = session_manager.get_session(sessionId)
    if not session or not session.tutorial_plan:
        raise HTTPException(status_code=404, detail="Session or tutorial plan not found")

    if not api_key:
        raise HTTPException(status_code=500, detail="API key not configured")

    plan = session.tutorial_plan

    # Update completed steps
    try:
        completed = json.loads(completedSteps)
        plan.completed_step_indices = completed
    except json.JSONDecodeError:
        pass

    plan.current_page_start_index = currentPlanStepIndex

    # Build remaining plan steps text
    remaining_steps = plan.plan_steps[currentPlanStepIndex:]
    plan_text = json.dumps(plan.plan_steps, indent=2)
    remaining_text = json.dumps(remaining_steps, indent=2)

    # DOM context
    dom_context = ""
    if dom:
        dom_context = f"""
INDEXED ELEMENTS ON THIS NEW PAGE:
Each interactive element has been assigned a numeric index. Reference elements by their index number.
The list below shows: [index] tagName "visible text" key-attributes

{dom}
"""

    prompt = f"""You are continuing a step-by-step tutorial that spans multiple pages.

COMPLETE TUTORIAL PLAN (generated earlier):
{plan_text}

COMPLETED STEPS: {json.dumps(plan.completed_step_indices)}
RESUME FROM: Step {currentPlanStepIndex + 1} (index {currentPlanStepIndex})

REMAINING STEPS:
{remaining_text}

The user has navigated to a NEW PAGE. Below is the fresh screenshot and indexed DOM of this new page.

{dom_context}

YOUR TASK:
1. Look at the remaining plan steps (from step {currentPlanStepIndex + 1} onward)
2. Identify which of those remaining steps can be performed on THIS page (visible in the screenshot/DOM)
3. Provide elementIndex highlights ONLY for steps visible on this page
4. Do NOT regenerate the plan -- use the existing plan step instructions

Return your response as JSON:
{{{{
  "currentPageHighlights": [
    {{{{"elementIndex": 3, "explanation": "Enter repository name here", "planStepNumber": 2}}}}
  ],
  "currentPageStepCount": 3,
  "currentPageRange": {{{{"startIndex": {currentPlanStepIndex}, "endIndex": {currentPlanStepIndex}}}}},
  "reasoning": "Your thought process..."
}}}}

CRITICAL:
- "planStepNumber" in each highlight must match the stepNumber from the plan
- "currentPageRange" startIndex and endIndex are indices into the original planSteps array
- Only include highlights for steps achievable on THIS page
- Use the indexed element list to find EXACT element indices
"""

    try:
        content_blocks = [{"type": "text", "text": prompt}]

        # Process screenshot if provided
        if screenshot:
            image_bytes = await screenshot.read()
            screenshot_image = Image.open(io.BytesIO(image_bytes))
            img_bytes = io.BytesIO()
            screenshot_image.save(img_bytes, format="PNG")
            img_bytes.seek(0)
            content_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.b64encode(img_bytes.getvalue()).decode("utf-8")
                }
            })

        response = client.messages.create(
            model=model_name,
            max_tokens=max_output_tokens,
            messages=[{"role": "user", "content": content_blocks}],
        )

        raw_text = ""
        for block in response.content:
            text_value = getattr(block, "text", None)
            if text_value:
                raw_text += text_value

        print(f"Continue-tutorial raw response: {raw_text}")

        # Clean markdown code blocks
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]

        try:
            parsed = json.loads(raw_text.strip())
        except json.JSONDecodeError:
            extracted = extract_json_object(raw_text)
            if extracted:
                parsed = json.loads(extracted.strip())
            else:
                raise

        highlights = parsed.get("currentPageHighlights", [])
        page_range = parsed.get("currentPageRange", {"startIndex": currentPlanStepIndex, "endIndex": currentPlanStepIndex})
        reasoning = parsed.get("reasoning", "")

        print(f"New page highlights: {len(highlights)}")
        print(f"Page range: {page_range}")
        for i, h in enumerate(highlights):
            print(f"  Highlight {i+1} → elementIndex={h.get('elementIndex', 'none')}, planStep={h.get('planStepNumber', '?')}")
        print("========================\n")

        # Update session plan state
        plan.current_page_start_index = page_range.get("startIndex", currentPlanStepIndex)

        return ContinueTutorialResponse(
            currentPageHighlights=highlights,
            currentPageStepCount=parsed.get("currentPageStepCount", len(highlights)),
            currentPageRange=page_range,
            reasoning=reasoning,
            sessionId=session.id,
        )

    except json.JSONDecodeError:
        print(f"Failed to parse continue-tutorial JSON: {raw_text}")
        raise HTTPException(status_code=500, detail="Failed to parse AI response")
    except Exception as e:
        print(f"Continue-tutorial error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class VerifyStepRequest(BaseModel):
    stepInstruction: str
    expectedResult: str
    screenshot: Optional[str] = None  # base64 encoded
    dom: Optional[str] = None
    clickedElement: str = ""

class VerifyStepResponse(BaseModel):
    isCorrect: bool
    confidence: float
    reason: str

@app.post("/verify", response_model=VerifyStepResponse)
async def verify_step(request: VerifyStepRequest):
    """
    Verify if a tutorial step was completed correctly.
    Uses fresh screenshot and DOM for better element identification.
    """
    if not api_key:
        return VerifyStepResponse(
            isCorrect=False,
            confidence=0.0,
            reason="API key not configured"
        )

    try:
        # Build verification prompt
        verify_prompt = f"""You are a tutorial verification assistant. Determine if the user correctly completed the following step.

Step Instruction: {request.stepInstruction}
Expected Result: {request.expectedResult}
User clicked on: {request.clickedElement}

Page Context:
{request.dom if request.dom else "(No DOM provided)"}

Based on the screenshot and page context, did the user successfully complete this step? Respond with:
{{
  "isCorrect": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}}"""

        # Build content blocks
        content_blocks = [{"type": "text", "text": verify_prompt}]

        # Add screenshot if provided
        if request.screenshot:
            content_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": request.screenshot
                }
            })

        # Call Claude for verification
        response = client.messages.create(
            model=model_name,
            max_tokens=200,
            messages=[{"role": "user", "content": content_blocks}],
        )

        raw_text = ""
        for block in response.content:
            text_value = getattr(block, "text", None)
            if text_value:
                raw_text += text_value

        # Parse JSON response
        try:
            result = json.loads(raw_text.strip())
        except json.JSONDecodeError:
            extracted = extract_json_object(raw_text)
            if extracted:
                result = json.loads(extracted.strip())
            else:
                raise

        return VerifyStepResponse(
            isCorrect=result.get("isCorrect", False),
            confidence=float(result.get("confidence", 0.5)),
            reason=result.get("reason", "")
        )

    except Exception as e:
        print(f"Verification error: {e}")
        return VerifyStepResponse(
            isCorrect=False,
            confidence=0.0,
            reason=f"Verification failed: {str(e)}"
        )

class DesktopScreenshotResponse(BaseModel):
    screenshot: str  # base64 encoded PNG

@app.get("/capture-desktop", response_model=DesktopScreenshotResponse)
async def capture_desktop():
    """
    Capture a desktop screenshot and return as base64 PNG.
    This is used when a desktop-level capture is needed instead of a tab-only capture.
    """
    try:
        # Capture the entire desktop
        screenshot = ImageGrab.grab()

        # Convert to PNG bytes
        img_byte_arr = io.BytesIO()
        screenshot.save(img_byte_arr, format='PNG')
        img_byte_arr.seek(0)

        # Encode as base64
        img_base64 = base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

        return DesktopScreenshotResponse(screenshot=img_base64)
    except Exception as e:
        print(f"Error capturing desktop: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to capture desktop: {str(e)}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
