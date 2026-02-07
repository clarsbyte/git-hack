import os
import io
import base64
from typing import Optional, List, Dict, Any
from PIL import Image
import json
import time
from dotenv import load_dotenv

# Try to import Anthropic SDK
try:
    from anthropic import Anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False
    print("⚠️ Anthropic SDK not installed. Install with: pip install anthropic")


# Load environment variables before reading Claude config
load_dotenv()

# Claude configuration
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY")
CLAUDE_MODEL = "claude-3-5-sonnet-20241022"
CLAUDE_MAX_TOKENS = int(os.getenv("CLAUDE_MAX_TOKENS", "1024"))


def initialize_claude():
    """Initialize Claude API client"""
    if not ANTHROPIC_AVAILABLE:
        return None

    if not CLAUDE_API_KEY:
        print("⚠️ CLAUDE_API_KEY not set in environment")
        return None

    try:
        return Anthropic(api_key=CLAUDE_API_KEY)
    except Exception as e:
        print(f"❌ Failed to initialize Claude: {e}")
        return None


def normalize_bbox(
    bbox: List[float],
    image_width: int,
    image_height: int
) -> Dict[str, float]:
    """
    Convert absolute pixel coordinates to normalized 0-1 coordinates.
    """
    x1, y1, x2, y2 = bbox

    # Ensure coordinates are within image bounds
    x1 = max(0, min(x1, image_width))
    x2 = max(0, min(x2, image_width))
    y1 = max(0, min(y1, image_height))
    y2 = max(0, min(y2, image_height))

    # Normalize to 0-1
    normalized_x = x1 / image_width
    normalized_y = y1 / image_height
    normalized_width = (x2 - x1) / image_width
    normalized_height = (y2 - y1) / image_height

    return {
        "x": round(normalized_x, 4),
        "y": round(normalized_y, 4),
        "width": round(normalized_width, 4),
        "height": round(normalized_height, 4)
    }


def denormalize_bbox(
    normalized_bbox: Dict[str, float],
    image_width: int,
    image_height: int
) -> Dict[str, int]:
    """
    Convert normalized 0-1 coordinates back to absolute pixels.
    """
    x = int(normalized_bbox["x"] * image_width)
    y = int(normalized_bbox["y"] * image_height)
    width = int(normalized_bbox["width"] * image_width)
    height = int(normalized_bbox["height"] * image_height)

    return {
        "x": x,
        "y": y,
        "width": width,
        "height": height
    }


def parse_claude_response(response_text: str, image_width: int, image_height: int) -> List[Dict[str, Any]]:
    """
    Parse Claude response to extract bounding boxes.
    Claude returns text descriptions, so we parse for bbox coordinates.
    """
    detections = []

    try:
        # Try to parse as JSON first
        parsed = json.loads(response_text.strip())

        if isinstance(parsed, dict) and "detections" in parsed:
            raw_detections = parsed["detections"]
        elif isinstance(parsed, list):
            raw_detections = parsed
        else:
            return []

        for det in raw_detections:
            if "bbox" not in det:
                continue

            bbox = det["bbox"]

            # Handle different bbox formats
            if isinstance(bbox, list) and len(bbox) == 4:
                x1, y1, x2, y2 = bbox
            elif isinstance(bbox, dict):
                # Handle {x, y, width, height} format
                if all(k in bbox for k in ["x", "y", "width", "height"]):
                    x1 = bbox["x"]
                    y1 = bbox["y"]
                    x2 = x1 + bbox["width"]
                    y2 = y1 + bbox["height"]
                else:
                    continue
            else:
                continue

            # Normalize to our standard format
            normalized = normalize_bbox([x1, y1, x2, y2], image_width, image_height)
            absolute = denormalize_bbox(normalized, image_width, image_height)

            detections.append({
                "label": det.get("label", "element"),
                "confidence": det.get("confidence", 0.85),
                "bbox": normalized,
                "bbox_absolute": absolute
            })

    except json.JSONDecodeError:
        # Fallback: try to extract bbox from text
        import re

        # Look for various bbox formats
        patterns = [
            r'\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]',  # [x1, y1, x2, y2]
            r'x1?:\s*(\d+).*?y1?:\s*(\d+).*?x2:\s*(\d+).*?y2:\s*(\d+)',  # x1: 100, y1: 200, x2: 300, y2: 400
            r'top:\s*(\d+).*?left:\s*(\d+).*?bottom:\s*(\d+).*?right:\s*(\d+)',  # CSS-style
        ]

        for pattern in patterns:
            matches = re.findall(pattern, response_text, re.IGNORECASE)
            for match in matches:
                coords = list(map(int, match))

                if len(coords) == 4:
                    x1, y1, x2, y2 = coords

                    # Sanity check: coordinates should be within image bounds
                    if (0 <= x1 <= image_width and 0 <= x2 <= image_width and
                        0 <= y1 <= image_height and 0 <= y2 <= image_height and
                        x2 > x1 and y2 > y1):

                        normalized = normalize_bbox([x1, y1, x2, y2], image_width, image_height)
                        absolute = denormalize_bbox(normalized, image_width, image_height)

                        detections.append({
                            "label": "detected_element",
                            "confidence": 0.75,
                            "bbox": normalized,
                            "bbox_absolute": absolute
                        })

    return detections


def detect_elements(
    image: Image.Image,
    query: str,
    viewport_width: int,
    viewport_height: int
) -> Dict[str, Any]:
    """
    Detect UI elements using Claude 3.5 Sonnet with vision.

    Args:
        image: PIL Image of the webpage
        query: Natural language query (e.g., "find the submit button")
        viewport_width: Viewport width in pixels
        viewport_height: Viewport height in pixels

    Returns:
        Dict with detections, latency, and reasoning
    """
    start_time = time.time()

    if not ANTHROPIC_AVAILABLE:
        return {
            "detections": [],
            "model_latency_ms": 0,
            "reasoning": "Anthropic SDK not available",
            "error": "anthropic package not installed"
        }

    client = initialize_claude()
    if client is None:
        return {
            "detections": [],
            "model_latency_ms": 0,
            "reasoning": "Claude API key not configured",
            "error": "CLAUDE_API_KEY environment variable not set"
        }

    try:
        # Convert PIL Image to base64
        buffered = io.BytesIO()
        image.save(buffered, format="PNG")
        img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')

        # Prepare prompt for bounding box detection
        prompt = f"""You are a UI element detector analyzing a webpage screenshot.

Query: {query}

Image dimensions: {viewport_width}x{viewport_height} pixels

Your task:
1. Locate the UI element(s) described in the query
2. Return bounding box coordinates in pixels

Return your response as JSON in this exact format:
{{
  "detections": [
    {{
      "label": "brief description of the element",
      "bbox": [x1, y1, x2, y2],
      "confidence": 0.0-1.0
    }}
  ]
}}

Where:
- x1, y1 = top-left corner (in pixels)
- x2, y2 = bottom-right corner (in pixels)
- confidence = your confidence level (0.0 to 1.0)

IMPORTANT:
- Coordinates must be within image bounds (0 to {viewport_width} for x, 0 to {viewport_height} for y)
- Return ONLY the JSON, no explanation text
- If multiple matches, return the most prominent one first"""

        # Call Claude API
        message = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=CLAUDE_MAX_TOKENS,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": img_base64,
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt
                        }
                    ],
                }
            ],
        )

        # Extract response text
        response_text = message.content[0].text

        # Parse detections
        detections = parse_claude_response(response_text, viewport_width, viewport_height)

        latency_ms = int((time.time() - start_time) * 1000)

        return {
            "detections": detections,
            "model_latency_ms": latency_ms,
            "reasoning": response_text[:200]  # First 200 chars
        }

    except Exception as e:
        latency_ms = int((time.time() - start_time) * 1000)
        print(f"❌ Claude detection error: {e}")
        import traceback
        traceback.print_exc()
        return {
            "detections": [],
            "model_latency_ms": latency_ms,
            "reasoning": f"Detection failed: {str(e)}",
            "error": str(e)
        }


def decode_base64_image(base64_string: str) -> Optional[Image.Image]:
    """
    Decode a base64-encoded image string to PIL Image.
    """
    try:
        # Remove data URL prefix if present
        if "," in base64_string:
            base64_string = base64_string.split(",", 1)[1]

        # Decode base64
        image_data = base64.b64decode(base64_string)

        # Open as PIL Image
        image = Image.open(io.BytesIO(image_data))

        # Convert to RGB if needed
        if image.mode != "RGB":
            image = image.convert("RGB")

        return image

    except Exception as e:
        print(f"❌ Failed to decode base64 image: {e}")
        return None


# Example usage
if __name__ == "__main__":
    print("Testing Claude VLM detector...")

    if not ANTHROPIC_AVAILABLE:
        print("❌ anthropic SDK not installed")
        print("   Install with: pip install anthropic")
    elif not CLAUDE_API_KEY:
        print("❌ CLAUDE_API_KEY not set")
        print("   Get API key from: https://console.anthropic.com/")
    else:
        print("✅ Claude API configured")
        print(f"   Model: {CLAUDE_MODEL}")
        print(f"   Max tokens: {CLAUDE_MAX_TOKENS}")
