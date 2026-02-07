"""
VLM Detector - Vision-Language Model for UI Element Detection

Uses Qwen2.5-VL-8B for visual element detection with normalized bounding boxes.
Model is loaded lazily on first request to avoid slowing down server startup.
"""

import os
import io
import base64
from typing import Optional, List, Dict, Any, Tuple
from PIL import Image
import torch
from transformers import AutoProcessor, AutoModelForVision2Seq
import json

# Model configuration
VLM_MODEL_NAME = os.getenv("VLM_MODEL", "Qwen/Qwen2.5-VL-8B")
VLM_DEVICE = os.getenv("VLM_DEVICE", "auto")  # auto, cpu, cuda
VLM_PRECISION = os.getenv("VLM_PRECISION", "float16")  # float32, float16
VLM_MAX_TOKENS = int(os.getenv("VLM_MAX_TOKENS", "512"))

# Global model instances (loaded lazily)
_vlm_model: Optional[Any] = None
_vlm_processor: Optional[Any] = None
_model_loading_error: Optional[str] = None


def get_vlm_model() -> Tuple[Optional[Any], Optional[Any]]:
    """
    Get or lazily load the VLM model and processor.
    Returns (model, processor) or (None, None) if loading failed.
    """
    global _vlm_model, _vlm_processor, _model_loading_error

    # If already loaded, return cached instances
    if _vlm_model is not None and _vlm_processor is not None:
        return _vlm_model, _vlm_processor

    # If previous load failed, return error
    if _model_loading_error is not None:
        print(f"⚠️ VLM model previously failed to load: {_model_loading_error}")
        return None, None

    # Load model for first time
    try:
        print(f"🔄 Loading VLM model: {VLM_MODEL_NAME}")
        print(f"   Device: {VLM_DEVICE}, Precision: {VLM_PRECISION}")

        # Determine torch dtype
        dtype = torch.float32
        if VLM_PRECISION == "float16":
            dtype = torch.float16

        # Load processor
        _vlm_processor = AutoProcessor.from_pretrained(
            VLM_MODEL_NAME,
            trust_remote_code=True
        )

        # Load model with optimizations
        _vlm_model = AutoModelForVision2Seq.from_pretrained(
            VLM_MODEL_NAME,
            torch_dtype=dtype,
            device_map=VLM_DEVICE,
            trust_remote_code=True
        )

        print(f"✅ VLM model loaded successfully")
        return _vlm_model, _vlm_processor

    except Exception as e:
        _model_loading_error = str(e)
        print(f"❌ Failed to load VLM model: {e}")
        return None, None


def normalize_bbox(
    bbox: List[float],
    image_width: int,
    image_height: int
) -> Dict[str, float]:
    """
    Convert absolute pixel coordinates to normalized 0-1 coordinates.

    Args:
        bbox: [x1, y1, x2, y2] in absolute pixels
        image_width: Image width in pixels
        image_height: Image height in pixels

    Returns:
        Dict with normalized bbox: {x, y, width, height} in 0-1 range
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

    Args:
        normalized_bbox: {x, y, width, height} in 0-1 range
        image_width: Image width in pixels
        image_height: Image height in pixels

    Returns:
        Dict with absolute bbox: {x, y, width, height} in pixels
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


def parse_vlm_response(response_text: str) -> List[Dict[str, Any]]:
    """
    Parse VLM model output to extract bounding boxes and labels.

    Expected format variations:
    - JSON: {"detections": [...]}
    - Plain text with coordinates

    Returns:
        List of detection dicts with {label, bbox, confidence}
    """
    detections = []

    # Try to parse as JSON first
    try:
        parsed = json.loads(response_text.strip())
        if isinstance(parsed, dict) and "detections" in parsed:
            return parsed["detections"]
        elif isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    # Fallback: Try to extract bbox coordinates from text
    # Format: "button at [x1, y1, x2, y2]"
    import re
    bbox_pattern = r'\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]'
    matches = re.findall(bbox_pattern, response_text)

    for match in matches:
        x1, y1, x2, y2 = map(int, match)
        detections.append({
            "label": "detected_element",
            "bbox": [x1, y1, x2, y2],
            "confidence": 0.8
        })

    return detections


def detect_elements(
    image: Image.Image,
    query: str,
    viewport_width: int,
    viewport_height: int
) -> Dict[str, Any]:
    """
    Detect UI elements in an image using VLM.

    Args:
        image: PIL Image of the webpage
        query: Natural language query (e.g., "find the submit button")
        viewport_width: Viewport width in pixels
        viewport_height: Viewport height in pixels

    Returns:
        Dict with:
        - detections: List of detected elements with normalized bboxes
        - model_latency_ms: Inference time in milliseconds
        - reasoning: Model's explanation
    """
    import time

    # Get model instances
    model, processor = get_vlm_model()

    if model is None or processor is None:
        return {
            "detections": [],
            "model_latency_ms": 0,
            "reasoning": "VLM model not available",
            "error": _model_loading_error or "Model loading failed"
        }

    start_time = time.time()

    try:
        # Prepare prompt for element detection
        # Qwen2.5-VL uses specific prompt format for bounding box detection
        prompt = f"""<|im_start|>system
You are a UI element detector. Locate UI elements in screenshots with precise bounding boxes.
<|im_end|>
<|im_start|>user
{query}
Return the coordinates as [x1, y1, x2, y2] where:
- (x1, y1) is the top-left corner
- (x2, y2) is the bottom-right corner
- Coordinates are in pixels relative to the image

Format your response as JSON:
{{
  "detections": [
    {{
      "label": "description of element",
      "bbox": [x1, y1, x2, y2],
      "confidence": 0.0-1.0
    }}
  ]
}}
<|im_end|>
<|im_start|>assistant
"""

        # Prepare inputs
        inputs = processor(
            text=prompt,
            images=image,
            return_tensors="pt"
        )

        # Move to device
        if torch.cuda.is_available() and VLM_DEVICE != "cpu":
            inputs = {k: v.to(model.device) for k, v in inputs.items()}

        # Generate response
        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=VLM_MAX_TOKENS,
                do_sample=False
            )

        # Decode response
        response_text = processor.decode(outputs[0], skip_special_tokens=True)

        # Parse detections
        raw_detections = parse_vlm_response(response_text)

        # Normalize bounding boxes
        detections = []
        for det in raw_detections:
            if "bbox" not in det:
                continue

            bbox_absolute = det["bbox"]
            if len(bbox_absolute) != 4:
                continue

            # Normalize bbox
            normalized = normalize_bbox(
                bbox_absolute,
                viewport_width,
                viewport_height
            )

            # Also include absolute coordinates for convenience
            absolute = denormalize_bbox(normalized, viewport_width, viewport_height)

            detections.append({
                "label": det.get("label", "element"),
                "confidence": det.get("confidence", 0.8),
                "bbox": normalized,
                "bbox_absolute": absolute
            })

        latency_ms = int((time.time() - start_time) * 1000)

        return {
            "detections": detections,
            "model_latency_ms": latency_ms,
            "reasoning": response_text[:200]  # First 200 chars as reasoning
        }

    except Exception as e:
        latency_ms = int((time.time() - start_time) * 1000)
        print(f"❌ VLM detection error: {e}")
        return {
            "detections": [],
            "model_latency_ms": latency_ms,
            "reasoning": f"Detection failed: {str(e)}",
            "error": str(e)
        }


def decode_base64_image(base64_string: str) -> Optional[Image.Image]:
    """
    Decode a base64-encoded image string to PIL Image.

    Args:
        base64_string: Base64 encoded image data

    Returns:
        PIL Image or None if decoding failed
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


# Example usage for testing
if __name__ == "__main__":
    # Test model loading
    model, processor = get_vlm_model()
    if model is not None:
        print("✅ VLM model loaded successfully")
        print(f"   Model type: {type(model).__name__}")
        print(f"   Device: {model.device if hasattr(model, 'device') else 'unknown'}")
    else:
        print("❌ VLM model failed to load")
