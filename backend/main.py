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
        inputs.append(f"""
You are a Site Tutor, an expert web developer and UI guide. 
Your goal is to answer the user's question about the website screenshot provided.
Crucially, you must also identify specific HTML elements on the screen that are relevant to your answer so we can highlight them.

User Question: "{message}"

Return your response strictly as a JSON object with this format:
{{
  "text": "Your conversational answer here...",
  "highlights": [
    {{ "selector": "unique_css_selector_for_element", "explanation": "Brief label for the highlight" }}
  ]
}}

For the 'selector':
- You MUST identify visual elements mentioned in your text.
- Use CSS selectors that are likely to work on this page.
- Look for 'id', 'class', 'aria-label', or 'data-testid' attributes if visible or guessable.
- Examples: 'a[href="/new"]', 'button.btn-primary', '#repository-name', 'summary.btn-primary'.
- If the user asks about a general concept (like "New Repo"), Highlight the specific button (e.g., the "+" icon or "New" button).
- If you cannot be precise, use a broader selector like 'header' or 'nav'.
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
