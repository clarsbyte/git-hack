import os
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
import uvicorn
from pydantic import BaseModel
from typing import List, Optional
import json
from dotenv import load_dotenv
from anthropic import Anthropic
from PIL import Image, ImageGrab
import io
import uuid
import asyncio
from session_manager import SessionManager
from lux_task_generator import LuxTaskGenerator
from lux_executor import lux_executor
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

api_key = os.getenv("ANTHROPIC_API_KEY")
if not api_key:
    print("WARNING: ANTHROPIC_API_KEY not found in environment variables.")

client = Anthropic(api_key=api_key)
model_name = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
max_output_tokens = int(os.getenv("CLAUDE_MAX_TOKENS", "2048"))

task_generator = LuxTaskGenerator(client, model_name, max_output_tokens)

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
             text="Please set your ANTHROPIC_API_KEY in the backend/.env file to enable the AI agent.",
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

        # Detect if this is an "I give up" request for LUX automation
        is_lux_trigger = any(phrase in message.lower() for phrase in [
            'i give up', 'just do it for me', 'can you do it', 'you do it',
            'help me do this', 'take over', 'do this for me'
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

        prompt_text = f"""
You are a Site Tutor, an expert web developer and UI guide.
Your goal is to answer the user's question about the website screenshot provided.
You must also identify specific HTML elements on the screen that are relevant to your answer so we can highlight them.

User Question: "{message}"

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
  "automation": null
}}

OR for automation:
{{
  "text": "Your conversational answer here...",
  "highlights": [],
  "automation": {{
    "type": "navigate",
    "url": "https://example.com/path"
  }}
}}

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
        print(f"Error calling Claude: {e}")
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

        # Start LUX execution with session to capture screenshots
        task_id = lux_executor.start_task(task_description, todos, session)

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

class DesktopScreenshotResponse(BaseModel):
    screenshot: str  # base64 encoded PNG

@app.get("/capture-desktop", response_model=DesktopScreenshotResponse)
async def capture_desktop():
    """
    Capture a desktop screenshot and return as base64 PNG.
    This is used when LUX automation opens new windows that the browser extension can't capture.
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
