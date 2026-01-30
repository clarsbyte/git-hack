import asyncio
from typing import Optional, Dict, Any
import os
from oagi.agent.tasker import TaskerAgent
from oagi import AsyncScreenshotMaker
from oagi.handler import AsyncPyautoguiActionHandler
from oagi.agent.observer import AsyncAgentObserver
from dataclasses import dataclass
import uuid
import json
from datetime import datetime
from PIL import ImageGrab
from session_manager import Session


@dataclass
class ProgressEvent:
    """Represents a progress event for SSE streaming"""
    event_type: str  # 'step', 'action', 'error', 'complete', 'task_generated'
    data: Dict[str, Any]


class LuxExecutor:
    """Executes LUX automation tasks and streams progress via SSE"""

    def __init__(self):
        self.running_tasks: Dict[str, asyncio.Task] = {}
        self.progress_queues: Dict[str, asyncio.Queue] = {}
        self.api_key = "sk-KdOREp11GDRhQsKSAYEFXyIVwyOwhXpFImsypRcJ-bE"

        if not self.api_key:
            print("WARNING: OAGI_API_KEY not found in environment")

    async def execute_task(
        self,
        task_id: str,
        task_description: str,
        todos: list[str],
        session: Optional[Session] = None,
        max_retries: int = 1
    ) -> None:
        """
        Execute a LUX task in the background with progress streaming.

        Args:
            task_id: Unique task identifier
            task_description: Main task description
            todos: List of step-by-step instructions
            max_retries: Maximum number of retry attempts on failure
        """
        queue = self.progress_queues.get(task_id)
        if not queue:
            print(f"Error: No queue found for task {task_id}")
            return

        retry_count = 0

        try:
            # Send task generation event
            await queue.put(ProgressEvent(
                event_type="task_generated",
                data={"task": task_description, "todos": todos}
            ))

            while retry_count <= max_retries:
                try:
                    print(f"[LUX] Starting execution for task {task_id} (attempt {retry_count + 1})")

                    observer = AsyncAgentObserver()
                    agent = TaskerAgent(
                        api_key=self.api_key,
                        model="lux-actor-1",
                        step_observer=observer,
                        max_steps=60,
                        temperature=0.0
                    )

                    agent.set_task(task_description, todos)

                    action_handler = AsyncPyautoguiActionHandler()
                    screenshot_maker = AsyncScreenshotMaker()

                    # Send start event
                    await queue.put(ProgressEvent(
                        event_type="step",
                        data={
                            "step": 0,
                            "description": f"Initializing LUX automation...",
                            "timestamp": str(datetime.now())
                        }
                    ))

                    # Capture initial desktop screenshot and save to session
                    if session:
                        try:
                            initial_screenshot = ImageGrab.grab()
                            session.add_message('bot', f"[LUX Starting] {task_description}", initial_screenshot)
                            print(f"[LUX] Saved initial screenshot to session")
                        except Exception as e:
                            print(f"[LUX] Failed to capture initial screenshot: {e}")

                    # Execute the task
                    print(f"[LUX] Executing task: {task_description}")
                    success = await agent.execute(
                        instruction=task_description,
                        action_handler=action_handler,
                        image_provider=screenshot_maker
                    )

                    # Capture final desktop screenshot and save to session
                    if session:
                        try:
                            final_screenshot = ImageGrab.grab()
                            session.add_message('bot', f"[LUX Completed] Task finished with status: {success}", final_screenshot)
                            print(f"[LUX] Saved final screenshot to session")
                        except Exception as e:
                            print(f"[LUX] Failed to capture final screenshot: {e}")

                    print(f"[LUX] Task execution completed. Success: {success}")

                    # Get memory/summary
                    memory = agent.get_memory()
                    status_summary = memory.get_todo_status_summary()

                    if success:
                        # Export HTML report
                        report_path = f"results/lux_execution_{task_id}.html"
                        os.makedirs("results", exist_ok=True)
                        observer.export("html", report_path)

                        # Send completion event
                        await queue.put(ProgressEvent(
                            event_type="complete",
                            data={
                                "success": True,
                                "summary": f"Task completed successfully! Completed {status_summary.get('completed', 0)} steps.",
                                "htmlReport": f"/reports/{task_id}.html",
                                "completedSteps": status_summary.get('completed', 0),
                                "totalSteps": len(todos)
                            }
                        ))
                        break  # Success, exit retry loop

                    else:
                        # Task failed
                        if retry_count < max_retries:
                            retry_count += 1
                            await queue.put(ProgressEvent(
                                event_type="retry",
                                data={
                                    "attempt": retry_count,
                                    "reason": "Task execution failed, retrying with same plan",
                                    "adjustedPlan": todos
                                }
                            ))
                            continue
                        else:
                            # Max retries exceeded
                            raise Exception(f"Task failed after {max_retries + 1} attempts")

                except Exception as e:
                    print(f"[LUX] Error during execution: {e}")
                    if retry_count < max_retries:
                        retry_count += 1
                        await queue.put(ProgressEvent(
                            event_type="retry",
                            data={
                                "attempt": retry_count,
                                "reason": f"Error: {str(e)}",
                                "adjustedPlan": todos
                            }
                        ))
                        continue
                    else:
                        raise

        except Exception as e:
            print(f"[LUX] Fatal error in task execution: {e}")
            # Send error event
            await queue.put(ProgressEvent(
                event_type="error",
                data={
                    "error": str(e),
                    "retry": False
                }
            ))

        finally:
            # Send done event to close stream
            await queue.put(None)
            # Cleanup
            if task_id in self.progress_queues:
                del self.progress_queues[task_id]
            if task_id in self.running_tasks:
                del self.running_tasks[task_id]

    def start_task(
        self,
        task_description: str,
        todos: list[str],
        session: Optional[Session] = None
    ) -> str:
        """
        Start a LUX task execution in the background.

        Args:
            task_description: Main task description
            todos: List of step-by-step instructions
            session: Optional session to save screenshots to

        Returns:
            task_id for streaming progress
        """
        task_id = str(uuid.uuid4())

        # Create queue for this task
        queue = asyncio.Queue()
        self.progress_queues[task_id] = queue

        # Start background task
        task = asyncio.create_task(
            self.execute_task(task_id, task_description, todos, session)
        )
        self.running_tasks[task_id] = task

        print(f"[LUX] Started task {task_id}: {task_description}")

        return task_id

    async def stream_progress(self, task_id: str):
        """
        Async generator that yields SSE-formatted progress events.

        Args:
            task_id: Task identifier

        Yields:
            SSE-formatted event strings
        """
        queue = self.progress_queues.get(task_id)
        if not queue:
            yield f"event: error\ndata: {json.dumps({'error': 'Task not found'})}\n\n"
            return


        while True:
            try:
                event = await queue.get()

                if event is None:
                    yield "event: done\ndata: null\n\n"
                    break

                # Format as SSE event
                yield f"event: {event.event_type}\ndata: {json.dumps(event.data)}\n\n"

            except Exception as e:
                print(f"[LUX] Error in stream: {e}")
                yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
                break


# Global executor instance
lux_executor = LuxExecutor()
