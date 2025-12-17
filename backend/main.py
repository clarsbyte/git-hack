import os
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from pydantic import BaseModel
from typing import List, Optional
import json
from dotenv import load_dotenv
import google.generativeai as genai
from PIL import Image
import io

load_dotenv()

# Configure Gemini
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    # Just a warning, app will still start but calls will fail if not set later
    print("WARNING: GEMINI_API_KEY not found in environment variables.")

genai.configure(api_key=api_key)

# Using Gemini 2.0 Flash (Experimental) as requested (closest to '2.5')
model = genai.GenerativeModel('gemini-2.5-flash')

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Highlight(BaseModel):
    selector: str
    explanation: str

class ChatResponse(BaseModel):
    text: str
    highlights: List[Highlight]

@app.post("/chat", response_model=ChatResponse)
async def chat(message: str = Form(...), screenshot: Optional[UploadFile] = File(None)):
    print(f"Received message: {message}")
    
    if not api_key:
         return ChatResponse(
             text="Please set your GEMINI_API_KEY in the backend/.env file to enable the AI agent.",
             highlights=[]
         )

    try:
        inputs = []
        # Detect if this is a "select" or "highlight" instruction
        is_selection_request = any(keyword in message.lower() for keyword in [
            'select', 'highlight', 'show me', 'point to', 'find', 'where is', 
            'click on', 'identify', 'mark', 'circle'
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

Return your response strictly as a JSON object with this format:
{{
  "text": "Your conversational answer here...",
  "highlights": [
    {{ "selector": "unique_css_selector_for_element", "explanation": "Brief label for the highlight" }}
  ]
}}

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
        
        if screenshot:
            print(f"Processing screenshot: {screenshot.filename}")
            image_bytes = await screenshot.read()
            image = Image.open(io.BytesIO(image_bytes))
            inputs.append(image)
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
            return ChatResponse(
                text=parsed.get("text", "I analyzed the page but couldn't formulate a response."),
                highlights=parsed.get("highlights", [])
            )
        except json.JSONDecodeError:
            print(f"Failed to parse JSON: {raw_text}")
            # Try to salvage text if possible, or just fail gracefully
            return ChatResponse(
                 text=raw_text, 
                 highlights=[]
            )

    except Exception as e:
        print(f"Error calling Gemini: {e}")
        return ChatResponse(
            text=f"I encountered an error analyzing the page: {str(e)}",
            highlights=[]
        )

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
