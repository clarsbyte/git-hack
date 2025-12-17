import os
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
import uvicorn
from pydantic import BaseModel
from typing import List, Optional
import json
from dotenv import load_dotenv
import google.generativeai as genai
from PIL import Image
import io
import uuid
import asyncio
from session_manager import SessionManager
from lux_task_generator import LuxTaskGenerator
from lux_executor import lux_executor

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    print("WARNING: GEMINI_API_KEY not found in environment variables.")

genai.configure(api_key=api_key)

model = genai.GenerativeModel('gemini-2.5-flash')

task_generator = LuxTaskGenerator(model)

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
    selector: str
    explanation: str

class AutomationAction(BaseModel):
    type: str  # "navigate", "click", "lux"
    url: Optional[str] = None
    selector: Optional[str] = None
    taskId: Optional[str] = None  # For LUX tasks

class ChatResponse(BaseModel):
    text: str
    highlights: List[Highlight]
    automation: Optional[AutomationAction] = None
    sessionId: Optional[str] = None  # Session tracking

@app.post("/chat", response_model=ChatResponse)
async def chat(
    message: str = Form(...),
    screenshot: Optional[UploadFile] = File(None),
    sessionId: Optional[str] = Form(None)
):
    print(f"Received message: {message}")

    # Get or create session
    session = session_manager.get_or_create_session(sessionId)
    print(f"Session ID: {session.id}")

    if not api_key:
         return ChatResponse(
             text="Please set your GEMINI_API_KEY in the backend/.env file to enable the AI agent.",
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

        inputs = []
        # Detect if this is a "select" or "highlight" instruction
        is_selection_request = any(keyword in message.lower() for keyword in [
            'select', 'highlight', 'show me', 'point to', 'find', 'where is',
            'click on', 'identify', 'mark', 'circle'
        ])

        # Detect if this is an "I give up" request for LUX automation
        is_lux_trigger = any(phrase in message.lower() for phrase in [
            'i give up', 'just do it for me', 'can you do it', 'you do it',
            'help me do this', 'take over', 'do this for me'
        ])
        
        selection_instructions = ""
        if is_selection_request:
            selection_instructions = """
IMPORTANT: The user wants you to SELECT/HIGHLIGHT a specific element on the page.
- You MUST return at least one highlight with a precise CSS selector.
- Look carefully at the screenshot to identify the exact element the user is referring to.
- If the user says "select the login button", find the actual login button in the image and generate a selector for it.
- If the user says "select the search bar", find the search input field and generate a selector.
- Be as specific as possible - prefer unique identifiers like IDs, or combine multiple attributes for precision.
"""
        
        # Enhanced instructions for finding multiple elements (like "all buttons")
        multiple_elements_instruction = ""
        if any(keyword in message.lower() for keyword in ['all', 'every', 'each']):
            multiple_elements_instruction = """
CRITICAL: The user wants to find MULTIPLE elements (e.g., "all buttons", "every link").
- You MUST look at the screenshot and identify EACH individual button/element visually.
- Generate a SEPARATE highlight entry for EACH distinct element you can see.
- DO NOT use generic selectors like 'button' or 'a.btn' that match everything.
- Instead, create specific selectors for each button you can identify:
  * Look for unique text content, positions, or nearby elements
  * Use structural selectors like 'nav button:first-child', 'header a:nth-child(2)'
  * Combine element type with parent context: 'header > nav > button', 'footer a[href*="about"]'
- If you see 5 buttons, return 5 separate highlight entries, each with a unique selector.
- Each selector should target ONE specific button, not all buttons at once.
"""
        
        inputs.append(f"""
You are a Site Tutor, an expert web developer and UI guide.
Your goal is to answer the user's question about the website screenshot provided.
Crucially, you must also identify specific HTML elements on the screen that are relevant to your answer so we can highlight them.

User Question: "{message}"

{selection_instructions}

{multiple_elements_instruction}

AUTOMATION CAPABILITY:
You have the ability to automate actions for the user. When the user expresses frustration, gives up, or asks you to do something for them, you can take control and automate the task.

Detect phrases like:
- "I give up"
- "Just do it for me"
- "Can you do it"
- "You do it"
- "Help me do this"
- Or any expression of wanting you to take over

When automation is appropriate, analyze what the user is trying to do and generate the correct automation action:

1. **Navigate to a URL** - Use when user wants to go to a specific page:
   - Creating a repository → "https://github.com/new"
   - Creating a gist → "https://gist.github.com/"
   - Account settings → Look for settings URL patterns
   - Documentation pages → Navigate to docs
   - Any other page they're trying to reach

2. **Click an element** - Use when user wants to click something on the current page:
   - Generate a CSS selector for the button/link they want to click
   - Examples: login button, submit button, menu item, etc.

IMPORTANT: Only provide automation when the user clearly wants you to take over. Don't automate simple questions or when they're just asking for information.

Return your response strictly as a JSON object with this format:
{{
  "text": "Your conversational answer here...",
  "highlights": [
    {{ "selector": "unique_css_selector_for_element", "explanation": "Brief label for the highlight" }}
  ],
  "automation": {{
    "type": "navigate",
    "url": "https://example.com/path"
  }}
}}

OR for click automation:
{{
  "text": "Your conversational answer here...",
  "highlights": [],
  "automation": {{
    "type": "click",
    "selector": "button.submit-btn"
  }}
}}

If no automation is needed, set "automation": null

CRITICAL SELECTOR RULES:
- You MUST analyze the screenshot carefully to identify ACTUAL elements visible on THIS specific page.
- DO NOT generate generic selectors that might work on any page (like 'button', 'a.btn', '.primary-button').
- You MUST look at the screenshot and identify what's actually there, then generate selectors that match THOSE specific elements.

For the 'selector':
- You MUST identify visual elements mentioned in your text or requested by the user.
- Use CSS selectors that are likely to work on THIS SPECIFIC PAGE based on what you see in the screenshot.
- Priority order for selector generation:
  1. ID attributes: '#element-id' (most reliable if visible)
  2. Stable attributes: '[data-testid="..."]', '[aria-label="..."]', '[name="..."]'
  3. Structural selectors with parent context: 'header button', 'nav > a:first-child', 'footer a[href="/about"]'
  4. Element type with text content context: Look for nearby text or labels in the screenshot
  5. Nth-child selectors: 'nav a:nth-child(2)', 'div.buttons button:first-child'
  6. Class names combined with element type AND parent: 'header button.primary', 'nav a.nav-link'
  7. Attribute selectors: 'input[type="text"]', 'a[href*="/login"]', 'button[type="submit"]'
- Examples of GOOD selectors: 
  - 'header nav button' (structural, specific to header nav)
  - 'nav > a[href="/docs"]' (structural with href)
  - 'div.hero-section button:first-child' (parent class + position)
  - 'footer a:nth-child(2)' (structural position)
- Examples of BAD selectors (too generic):
  - 'button' (matches all buttons)
  - 'a.btn, a.button' (generic, might not exist)
  - '.primary-button' (class might not exist)
- If the user asks to "select" or "highlight" something, you MUST include it in highlights.
- If asking for "all buttons", identify EACH button individually with separate selectors.
- For each element, look at its position, nearby text, parent elements, and generate a selector that uniquely identifies THAT element.
- If you cannot find a precise selector, use structural selectors based on position (nth-child, first-child, etc.) combined with parent context.
""")
        
        if screenshot_image:
            inputs.append(screenshot_image)
        else:
            inputs.append("\n(No screenshot provided, answer based on general web knowledge if possible)")

        # Generate content
        # Note: 'response_mime_type': 'application/json' is powerful but sometimes requires cleaning
        response = model.generate_content(inputs, generation_config={"response_mime_type": "application/json"})
        
        raw_text = response.text
        print(f"Gemini raw response: {raw_text}") 
        
        # Clean potential markdown code blocks
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
        
        try:
            parsed = json.loads(raw_text.strip())

            bot_response_text = parsed.get("text", "I analyzed the page but couldn't formulate a response.")

            # Store bot message in session
            session.add_message('bot', bot_response_text)

            # Parse automation if present
            automation_data = parsed.get("automation")
            automation = None

            # Override with LUX automation if trigger detected
            if is_lux_trigger:
                automation = AutomationAction(
                    type="lux",
                    taskId=str(uuid.uuid4())
                )
            elif automation_data and isinstance(automation_data, dict):
                automation = AutomationAction(**automation_data)

            return ChatResponse(
                text=bot_response_text,
                highlights=parsed.get("highlights", []),
                automation=automation,
                sessionId=session.id
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
        print(f"Error calling Gemini: {e}")
        return ChatResponse(
            text=f"I encountered an error analyzing the page: {str(e)}",
            highlights=[],
            automation=None,
            sessionId=session.id
        )

class AutomateRequest(BaseModel):
    sessionId: str
    userIntent: str

class AutomateResponse(BaseModel):
    taskId: str
    status: str
    streamUrl: str

@app.post("/automate", response_model=AutomateResponse)
async def automate(request: AutomateRequest):
    """
    Trigger LUX automation based on conversation history.
    """
    # Get session
    session = session_manager.get_session(request.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        print(f"[AUTOMATE] Generating task for intent: {request.userIntent}")

        # Generate task from conversation history
        task_description, todos = await task_generator.generate_task_from_history(
            session,
            request.userIntent
        )

        print(f"[AUTOMATE] Generated task: {task_description}")
        print(f"[AUTOMATE] Generated {len(todos)} steps")

        # Start LUX execution
        task_id = lux_executor.start_task(task_description, todos)

        return AutomateResponse(
            taskId=task_id,
            status="started",
            streamUrl=f"/automate/stream/{task_id}"
        )

    except Exception as e:
        print(f"[AUTOMATE] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/automate/stream/{task_id}")
async def stream_automation(task_id: str):
    """
    Stream LUX execution progress via Server-Sent Events.
    """
    return StreamingResponse(
        lux_executor.stream_progress(task_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # Disable nginx buffering
        }
    )

@app.get("/reports/{task_id}.html")
async def get_report(task_id: str):
    """
    Serve HTML execution reports.
    """
    report_path = f"results/lux_execution_{task_id}.html"
    if not os.path.exists(report_path):
        raise HTTPException(status_code=404, detail="Report not found")

    return FileResponse(report_path)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
