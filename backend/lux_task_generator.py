from anthropic import Anthropic
from typing import Tuple, List
from session_manager import Session
import json
import io
import base64


class LuxTaskGenerator:
    """Generates detailed LUX automation tasks from conversation history"""

    def __init__(self, client: Anthropic, model_name: str, max_output_tokens: int):
        self.client = client
        self.model_name = model_name
        self.max_output_tokens = max_output_tokens

    @staticmethod
    def _extract_json_object(raw_text: str) -> str | None:
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

    async def generate_task_from_history(
        self,
        session: Session,
        user_intent: str
    ) -> Tuple[str, List[str]]:
        """
        Generate detailed LUX task description and todo list from conversation history.

        Args:
            session: Session with conversation history
            user_intent: What the user wants to accomplish (extracted from "I give up on X")

        Returns:
            (task_description, todos_list)
        """

        # Build context from conversation history
        conversation_history = session.get_conversation_history()

        # Get the latest screenshot
        latest_screenshot = session.get_latest_screenshot()

        prompt = f"""
You are an expert task automation planner for the OAGI LUX computer-use agent.

The user has expressed they want you to take over and complete a task for them.

CONVERSATION HISTORY:
{conversation_history}

USER'S INTENT: {user_intent}

Based on the conversation history and the user's current frustration, generate:

1. A clear, detailed task description (1-2 sentences)
2. A step-by-step todo list (each step should be actionable and specific)

Consider:
- What the user has tried already (from conversation history)
- What they're trying to accomplish
- The current state of their screen (from screenshot)
- Specific steps needed to complete the task

IMPORTANT GUIDELINES FOR TODO STEPS:
- Each step should be concrete and actionable (e.g., "Click the 'New Repository' button on GitHub")
- Steps should be in logical order
- Include verification steps if needed (e.g., "Wait for repository creation confirmation")
- Be specific about what to click, type, or interact with
- Assume the agent has full desktop control (can open browsers, apps, etc.)
- For form filling, specify exact field names and values
- For clicks, describe the exact button/link text or visual appearance

CRITICAL - WORK ON THE CURRENT SCREEN:
- DO NOT create new tabs or navigate to new URLs unless absolutely critical to the task
- WORK WITH THE CURRENT PAGE that the user is already viewing (visible in the screenshot)
- If the user is on a page, interact with elements ON THAT PAGE
- Only navigate away if the task EXPLICITLY requires going to a completely different website
- Example: If user says "I give up on creating a repo" while on GitHub, use the NEW REPOSITORY button already visible on their screen
- Example: If user says "I give up on filling this form", fill out the form elements already on the current page
- Focus on clicking, typing, scrolling on the EXISTING page rather than navigating elsewhere

EXAMPLES OF GOOD STEPS (working on current screen):
- "Locate the 'New Repository' button in the top right corner and click it"
- "Click on the 'Repository name' input field that is visible on the current page"
- "Type 'my-new-repo' in the repository name field"
- "Scroll down to find the 'Create repository' button and click it"
- "Fill in the email field with 'user@example.com' in the form on this page"
- "Click the 'Submit' button at the bottom of the current form"
- "Select the dropdown menu labeled 'Category' and choose the first option"

EXAMPLES OF BAD STEPS (too vague or creating new tabs):
- "Open a new tab and go to github.com" (BAD - don't create new tabs unless necessary)
- "Navigate to https://github.com/new" (BAD - work with current page first)
- "Create a repository" (BAD - too vague)
- "Fill out the form" (BAD - not specific enough)
- "Click submit" (BAD - which submit button? where?)

Return your response as JSON:
{{
  "task": "Brief task description",
  "todos": [
    "Step 1: ...",
    "Step 2: ...",
    "Step 3: ..."
  ]
}}
"""

        content_blocks = [{"type": "text", "text": prompt}]
        if latest_screenshot:
            img_bytes = io.BytesIO()
            latest_screenshot.save(img_bytes, format="PNG")
            img_bytes.seek(0)
            content_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.b64encode(img_bytes.getvalue()).decode("utf-8")
                }
            })

        response = self.client.messages.create(
            model=self.model_name,
            max_tokens=self.max_output_tokens,
            messages=[{"role": "user", "content": content_blocks}],
        )

        # Parse response
        raw_text = ""
        for block in response.content:
            text_value = getattr(block, "text", None)
            if text_value:
                raw_text += text_value
        raw_text = raw_text.strip()
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]

        try:
            parsed = json.loads(raw_text.strip())
        except json.JSONDecodeError:
            extracted = self._extract_json_object(raw_text)
            if extracted:
                parsed = json.loads(extracted.strip())
            else:
                raise

        return (parsed["task"], parsed["todos"])
