import argparse
import asyncio
import os
import traceback
from datetime import datetime

from oagi import AsyncScreenshotMaker
from oagi.agent.observer import AsyncAgentObserver
from oagi.agent.tasker import TaskerAgent
from oagi.handler import AsyncPyautoguiActionHandler


async def main():
    parser = argparse.ArgumentParser(description='Crawl Amazon for product data')
    parser.add_argument('--product_name', type=str, default='purse', help='Product name to search for')
    parser.add_argument('--exp_name', type=str, default='amazon_crawl', help='Experiment name')
    parser.add_argument('--save_dir', type=str, default='results/', help='Directory to save results')
    parser.add_argument('--model_name', type=str, default='lux-actor-1', help='Model name')
    parser.add_argument('--max_steps', type=int, default=24, help='Max steps per todo')
    parser.add_argument('--temperature', type=float, default=0.0, help='Temperature')

    args = parser.parse_args()

    save_dir = os.path.join(args.save_dir, args.exp_name)
    os.makedirs(save_dir, exist_ok=True)

    instruction = f"Find the information about the top-selling {args.product_name} on Amazon"
    todos = [
        f"Open a new tab, go to www.amazon.com, and search for {args.product_name} in the search bar",
        f"Click on 'Sort by' in the top right of the page and select 'Best Sellers'",
    ]

    observer = AsyncAgentObserver()
    image_provider = AsyncScreenshotMaker()
    action_handler = AsyncPyautoguiActionHandler()

    tasker = TaskerAgent(
        api_key=os.getenv("OAGI_API_KEY"),
        base_url=os.getenv("OAGI_BASE_URL", "https://api.agiopen.org"),
        model=args.model_name,
        max_steps=args.max_steps,
        temperature=args.temperature,
        step_observer=observer,
    )

    tasker.set_task(task=instruction, todos=todos)

    print(f"Starting task execution at {datetime.now()}")
    print(f"Task: {instruction}")
    print(f"Number of todos: {len(todos)}")
    print("=" * 60)

    try:
        success = await tasker.execute(
            instruction="",
            action_handler=action_handler,
            image_provider=image_provider,
        )

        memory = tasker.get_memory()

        print("\n" + "=" * 60)
        print("EXECUTION SUMMARY")
        print("=" * 60)
        print(f"Overall success: {success}")
        print(f"\nTask execution summary:\n{memory.task_execution_summary}")

        print("\nTodo Status:")
        for i, todo in enumerate(memory.todos):
            status_icon = {
                "completed": "✅",
                "pending": "⏳",
                "in_progress": "🔄",
                "skipped": "⏭️",
            }.get(todo.status.value, "❓")
            print(f"  {status_icon} [{i + 1}] {todo.description} - {todo.status.value}")

        status_summary = memory.get_todo_status_summary()
        print("\nExecution Statistics:")
        print(f"  Completed: {status_summary.get('completed', 0)}")
        print(f"  Pending: {status_summary.get('pending', 0)}")
        print(f"  In Progress: {status_summary.get('in_progress', 0)}")
        print(f"  Skipped: {status_summary.get('skipped', 0)}")

    except Exception as e:
        print(f"\n❌ Error during execution: {e}")
        traceback.print_exc()

    output_file = os.path.join(save_dir, f"{args.product_name}_execution_history.html")
    observer.export("html", output_file)
    print(f"\n📄 Execution history exported to: {output_file}")


if __name__ == '__main__':
    asyncio.run(main())