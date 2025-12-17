import google.generativeai as genai
from typing import Tuple, List
from session_manager import Session
import json


class LuxTaskGenerator:
    """Generates detailed LUX automation tasks from conversation history"""

    def __init__(self, model: genai.GenerativeModel):
        self.model = model

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

        inputs = [prompt]
        if latest_screenshot:
            inputs.append(latest_screenshot)

        response = self.model.generate_content(
            inputs,
            generation_config={"response_mime_type": "application/json"}
        )

        # Parse response
        raw_text = response.text.strip()
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]

        parsed = json.loads(raw_text.strip())

        return (parsed["task"], parsed["todos"])
