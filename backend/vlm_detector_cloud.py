import os
import io
import base64
from typing import Optional, List, Dict, Any, Tuple
from PIL import Image, ImageDraw, ImageFont
import json
import time
import math
import re
from datetime import datetime
from pathlib import Path
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
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5-20250929")
CLAUDE_MAX_TOKENS = int(os.getenv("CLAUDE_MAX_TOKENS", "1024"))
VLM_MIN_CONFIDENCE = float(os.getenv("VLM_MIN_CONFIDENCE", "0.55"))
VLM_MIN_RELATIVE_AREA = float(os.getenv("VLM_MIN_RELATIVE_AREA", "0.0002"))
VLM_MAX_RELATIVE_AREA = float(os.getenv("VLM_MAX_RELATIVE_AREA", "0.80"))
VLM_MAX_DETECTIONS = int(os.getenv("VLM_MAX_DETECTIONS", "8"))
VLM_DEBUG_VERBOSE = os.getenv("VLM_DEBUG_VERBOSE", "1").strip().lower() in {"1", "true", "yes", "on"}
VLM_ALLOW_GENERIC_LABELS = os.getenv("VLM_ALLOW_GENERIC_LABELS", "0").strip().lower() in {"1", "true", "yes", "on"}
VLM_DEBUG_REJECT_DETAILS = os.getenv("VLM_DEBUG_REJECT_DETAILS", "1").strip().lower() in {"1", "true", "yes", "on"}
VLM_SAVE_DEBUG_IMAGES = os.getenv("VLM_SAVE_DEBUG_IMAGES", "1").strip().lower() in {"1", "true", "yes", "on"}
VLM_DEBUG_DIR = os.getenv("VLM_DEBUG_DIR", "debug/vlm_detections")

GENERIC_LABELS = {
    "element",
    "ui element",
    "detected element",
    "detected_element",
    "container",
    "section",
    "area",
    "region",
    "box",
}

UI_ARTIFACT_LABEL_HINTS = (
    "chat",
    "message bubble",
    "chat interface",
    "site tutor",
    "tutorial step",
    "verify step",
    "send message",
    "overlay",
)


def _sanitize_session_folder_name(session_id: Optional[str]) -> str:
    raw = str(session_id or "").strip()
    if not raw:
        return ""
    sanitized = re.sub(r"[^A-Za-z0-9_.-]+", "_", raw).strip("._-")
    return sanitized or ""


def get_vlm_debug_dir_for_session(session_id: Optional[str] = None) -> Path:
    base_dir = Path(VLM_DEBUG_DIR)
    session_folder = _sanitize_session_folder_name(session_id)
    if session_folder:
        return base_dir / session_folder
    return base_dir


def ensure_vlm_debug_dir(session_id: Optional[str] = None) -> Path:
    debug_dir = get_vlm_debug_dir_for_session(session_id)
    debug_dir.mkdir(parents=True, exist_ok=True)
    return debug_dir


def _looks_like_ui_artifact_label(label: str) -> bool:
    lower = (label or "").strip().lower()
    if not lower:
        return False
    return any(hint in lower for hint in UI_ARTIFACT_LABEL_HINTS)


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


def parse_claude_response(
    response_text: str,
    image_width: int,
    image_height: int
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Parse Claude response to extract detections and parse diagnostics.
    """
    detections = []
    parse_diagnostics: Dict[str, Any] = {
        "mode": "none",
        "json_candidate_count": 0,
        "json_error": None,
    }

    def _extract_fenced_json_candidates(text: str) -> List[str]:
        candidates: List[str] = []
        for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE):
            candidate = (match.group(1) or "").strip()
            if candidate:
                candidates.append(candidate)
        return candidates

    def _extract_balanced_json_fragment(text: str) -> Optional[str]:
        start = -1
        depth = 0
        in_string = False
        escaped = False
        for i, ch in enumerate(text):
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue

            if ch == '"':
                in_string = True
                continue

            if ch in "{[":
                if depth == 0:
                    start = i
                depth += 1
            elif ch in "}]":
                if depth > 0:
                    depth -= 1
                    if depth == 0 and start >= 0:
                        return text[start:i + 1]
        return None

    try:
        # Try strict/structured JSON candidates first.
        stripped = response_text.strip()
        candidates: List[Tuple[str, str]] = []
        for candidate in _extract_fenced_json_candidates(stripped):
            candidates.append(("fenced_json", candidate))
        candidates.append(("raw_text", stripped))
        fragment = _extract_balanced_json_fragment(stripped)
        if fragment and fragment != stripped:
            candidates.append(("balanced_fragment", fragment))

        parse_diagnostics["json_candidate_count"] = len(candidates)
        parsed: Any = None
        parsed_ok = False
        for mode, candidate in candidates:
            try:
                parsed = json.loads(candidate)
                parse_diagnostics["mode"] = mode
                parsed_ok = True
                break
            except json.JSONDecodeError as err:
                parse_diagnostics["json_error"] = str(err)

        if not parsed_ok:
            raise json.JSONDecodeError("No JSON candidate parsed", stripped, 0)

        if isinstance(parsed, dict) and "detections" in parsed:
            raw_detections = parsed["detections"]
        elif isinstance(parsed, list):
            raw_detections = parsed
        else:
            return [], parse_diagnostics

        for det in raw_detections:
            if not isinstance(det, dict) or "bbox" not in det:
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

            if not all(isinstance(v, (int, float)) and math.isfinite(float(v)) for v in [x1, y1, x2, y2]):
                continue
            if x2 <= x1 or y2 <= y1:
                continue

            # Normalize to our standard format
            normalized = normalize_bbox([x1, y1, x2, y2], image_width, image_height)
            absolute = denormalize_bbox(normalized, image_width, image_height)
            label = str(det.get("label", "element")).strip()
            confidence = det.get("confidence", 0.85)
            try:
                confidence = float(confidence)
            except (TypeError, ValueError):
                confidence = 0.0

            detections.append({
                "label": label,
                "confidence": confidence,
                "bbox": normalized,
                "bbox_absolute": absolute
            })

    except json.JSONDecodeError:
        # Fallback: try to extract bbox from text
        parse_diagnostics["mode"] = "regex_fallback"

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

    return detections, parse_diagnostics


def _filter_detections(
    detections: List[Dict[str, Any]],
    image_width: int,
    image_height: int,
    query: str = "",
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Enforce detection quality contract before downstream mapping.
    """
    filtered: List[Dict[str, Any]] = []
    rejected_samples: List[Dict[str, Any]] = []
    dropped: Dict[str, int] = {
        "empty_label": 0,
        "generic_label": 0,
        "ui_artifact_label": 0,
        "invalid_confidence": 0,
        "out_of_range_confidence": 0,
        "low_confidence": 0,
        "invalid_box_size": 0,
        "negative_coords": 0,
        "out_of_bounds_box": 0,
        "area_out_of_range": 0,
    }
    total_area = float(max(1, image_width * image_height))
    max_rejected_samples = 5

    def _record_reject(reason: str, det: Dict[str, Any], rel_area: Optional[float] = None) -> None:
        if not VLM_DEBUG_REJECT_DETAILS:
            return
        if len(rejected_samples) >= max_rejected_samples:
            return
        sample: Dict[str, Any] = {
            "reason": reason,
            "label": det.get("label"),
            "confidence": det.get("confidence"),
            "bbox_absolute": det.get("bbox_absolute"),
        }
        if rel_area is not None:
            sample["relative_area"] = round(rel_area, 6)
        rejected_samples.append(sample)

    query_lower = (query or "").strip().lower()
    query_tokens = re.findall(r"[a-z0-9]+", query_lower)
    high_level_intent_markers = {
        "how", "buy", "purchase", "order", "shop", "find", "where", "get", "tutorial", "guide"
    }
    allow_intent_generic_labels = bool(
        query_lower and (
            "how to " in query_lower
            or any(tok in high_level_intent_markers for tok in query_tokens)
        )
    )
    query_hint = " ".join([tok for tok in query_tokens if tok not in {"how", "to", "the", "a", "an"}][:6]).strip()

    for det in detections:
        label = str(det.get("label", "")).strip()
        label_lower = label.lower()
        if not label:
            dropped["empty_label"] += 1
            _record_reject("empty_label", det)
            continue
        is_generic = label_lower in GENERIC_LABELS
        is_ui_artifact = _looks_like_ui_artifact_label(label)

        # Drop extension/chat UI labels by default; keep only for explicit chat queries.
        if is_ui_artifact and "chat" not in query_lower:
            dropped["ui_artifact_label"] += 1
            _record_reject("ui_artifact_label", det)
            continue

        try:
            confidence = float(det.get("confidence", 0.0) or 0.0)
        except (TypeError, ValueError):
            dropped["invalid_confidence"] += 1
            _record_reject("invalid_confidence", det)
            continue
        if not (0.0 <= confidence <= 1.0):
            dropped["out_of_range_confidence"] += 1
            _record_reject("out_of_range_confidence", det)
            continue
        if confidence < VLM_MIN_CONFIDENCE:
            dropped["low_confidence"] += 1
            _record_reject("low_confidence", det)
            continue

        if is_generic and not VLM_ALLOW_GENERIC_LABELS:
            if allow_intent_generic_labels:
                # Keep generic detections for broad intent queries, but relabel so
                # downstream ranking can still align to query tokens.
                label = query_hint or "query target candidate"
            else:
                dropped["generic_label"] += 1
                _record_reject("generic_label", det)
                continue

        bbox_abs = det.get("bbox_absolute", {}) or {}
        w = float(bbox_abs.get("width", 0) or 0)
        h = float(bbox_abs.get("height", 0) or 0)
        x = float(bbox_abs.get("x", 0) or 0)
        y = float(bbox_abs.get("y", 0) or 0)
        if w <= 1 or h <= 1:
            dropped["invalid_box_size"] += 1
            _record_reject("invalid_box_size", det)
            continue
        if x < 0 or y < 0:
            dropped["negative_coords"] += 1
            _record_reject("negative_coords", det)
            continue
        if x + w > image_width + 1 or y + h > image_height + 1:
            dropped["out_of_bounds_box"] += 1
            _record_reject("out_of_bounds_box", det)
            continue

        rel_area = (w * h) / total_area
        if rel_area < VLM_MIN_RELATIVE_AREA or rel_area > VLM_MAX_RELATIVE_AREA:
            dropped["area_out_of_range"] += 1
            _record_reject("area_out_of_range", det, rel_area=rel_area)
            continue

        filtered.append({
            "label": label,
            "confidence": round(confidence, 4),
            "bbox": det.get("bbox", {}),
            "bbox_absolute": det.get("bbox_absolute", {}),
        })

    filtered.sort(
        key=lambda d: (
            float(d.get("confidence", 0.0) or 0.0),
            float((d.get("bbox_absolute", {}).get("width", 0) or 0) * (d.get("bbox_absolute", {}).get("height", 0) or 0)),
        ),
        reverse=True,
    )
    limited = filtered[:max(1, VLM_MAX_DETECTIONS)]
    dropped_by_limit = max(0, len(filtered) - len(limited))
    diagnostics = {
        "raw_count": len(detections),
        "kept_count": len(limited),
        "dropped_count": max(0, len(detections) - len(limited)),
        "dropped_by_limit": dropped_by_limit,
        "drop_reasons": dropped,
        "rejected_samples": rejected_samples,
        "intent_generic_label_fallback": allow_intent_generic_labels,
    }
    return limited, diagnostics


def save_debug_visualization(
    image: Image.Image,
    query: str,
    raw_detections: List[Dict[str, Any]],
    filtered_detections: List[Dict[str, Any]],
    diagnostics: Dict[str, Any],
    response_text: str,
    session_id: Optional[str] = None
) -> Optional[str]:
    """
    Save debug visualization with bounding boxes and detection info.

    Returns: Path to saved HTML file, or None if disabled
    """
    if not VLM_SAVE_DEBUG_IMAGES:
        return None

    try:
        # Create debug directory (session-scoped when session_id is provided)
        debug_dir = ensure_vlm_debug_dir(session_id)

        # Generate timestamp-based filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        base_name = f"vlm_{timestamp}"

        # Save original image
        img_path = debug_dir / f"{base_name}_original.png"
        image.save(img_path)

        # Create annotated image with bounding boxes
        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)

        # Try to load a font, fall back to default if not available
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 14)
            font_small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
        except:
            font = ImageFont.load_default()
            font_small = ImageFont.load_default()

        # Draw raw detections in red (rejected/filtered out)
        for i, det in enumerate(raw_detections):
            bbox = det.get('bbox_absolute')
            if not bbox:
                continue

            # Handle both dict and list formats
            if isinstance(bbox, dict):
                x1 = bbox.get('x', 0)
                y1 = bbox.get('y', 0)
                width = bbox.get('width', 0)
                height = bbox.get('height', 0)
                x2 = x1 + width
                y2 = y1 + height
            elif isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                x1, y1, x2, y2 = bbox
            else:
                continue

            label = det.get('label', 'unknown')
            confidence = det.get('confidence', 0)

            # Check if this detection was kept (in filtered list)
            kept = any(
                f.get('bbox_absolute') == bbox
                for f in filtered_detections
            )

            if not kept:
                # Draw red box for rejected detections
                draw.rectangle([x1, y1, x2, y2], outline="red", width=2)
                text = f"❌ {label} ({confidence:.2f})"
                # Draw text background
                text_bbox = draw.textbbox((x1, y1 - 18), text, font=font_small)
                draw.rectangle(text_bbox, fill="red")
                draw.text((x1, y1 - 18), text, fill="white", font=font_small)

        # Draw filtered (kept) detections in green
        for i, det in enumerate(filtered_detections):
            bbox = det.get('bbox_absolute')
            if not bbox:
                continue

            # Handle both dict and list formats
            if isinstance(bbox, dict):
                x1 = bbox.get('x', 0)
                y1 = bbox.get('y', 0)
                width = bbox.get('width', 0)
                height = bbox.get('height', 0)
                x2 = x1 + width
                y2 = y1 + height
            elif isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                x1, y1, x2, y2 = bbox
            else:
                continue

            label = det.get('label', 'unknown')
            confidence = det.get('confidence', 0)

            # Draw green box for kept detections
            draw.rectangle([x1, y1, x2, y2], outline="green", width=3)
            text = f"✓ {label} ({confidence:.2f})"
            # Draw text background
            text_bbox = draw.textbbox((x1, y1 - 20), text, font=font)
            draw.rectangle(text_bbox, fill="green")
            draw.text((x1, y1 - 20), text, fill="white", font=font)

        # Save annotated image
        annotated_path = debug_dir / f"{base_name}_annotated.png"
        annotated.save(annotated_path)

        # Save detection data as JSON
        json_data = {
            "timestamp": timestamp,
            "session_id": session_id,
            "query": query,
            "raw_detections": raw_detections,
            "filtered_detections": filtered_detections,
            "diagnostics": diagnostics,
            "vlm_response": response_text
        }
        json_path = debug_dir / f"{base_name}_data.json"
        with open(json_path, 'w') as f:
            json.dump(json_data, f, indent=2)

        # Create HTML viewer
        html_content = f"""<!DOCTYPE html>
<html>
<head>
    <title>VLM Debug: {timestamp}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; background: #f5f5f5; }}
        .container {{ max-width: 1400px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }}
        h1 {{ color: #333; }}
        .query {{ background: #e3f2fd; padding: 15px; border-radius: 4px; margin: 20px 0; border-left: 4px solid #2196F3; }}
        .stats {{ display: flex; gap: 20px; margin: 20px 0; }}
        .stat {{ background: #f5f5f5; padding: 15px; border-radius: 4px; flex: 1; }}
        .stat-value {{ font-size: 24px; font-weight: bold; color: #2196F3; }}
        .stat-label {{ font-size: 12px; color: #666; margin-top: 5px; }}
        .images {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }}
        .image-container {{ text-align: center; }}
        .image-container img {{ max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }}
        .image-label {{ margin-top: 10px; font-weight: bold; color: #555; }}
        .detections {{ margin: 20px 0; }}
        .detection {{ background: #f9f9f9; padding: 15px; margin: 10px 0; border-radius: 4px; border-left: 4px solid #4CAF50; }}
        .detection.rejected {{ border-left-color: #f44336; opacity: 0.7; }}
        .detection-header {{ font-weight: bold; margin-bottom: 8px; }}
        .detection-info {{ font-size: 14px; color: #666; }}
        .json-section {{ background: #263238; color: #aed581; padding: 15px; border-radius: 4px; overflow-x: auto; }}
        pre {{ margin: 0; }}
        .legend {{ display: flex; gap: 20px; margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 4px; }}
        .legend-item {{ display: flex; align-items: center; gap: 8px; }}
        .legend-box {{ width: 20px; height: 20px; border-radius: 3px; }}
        .legend-box.kept {{ background: #4CAF50; }}
        .legend-box.rejected {{ background: #f44336; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 VLM Detection Debug Viewer</h1>
        <p><strong>Timestamp:</strong> {timestamp}</p>

        <div class="query">
            <strong>Query:</strong> {query}
        </div>

        <div class="stats">
            <div class="stat">
                <div class="stat-value">{len(raw_detections)}</div>
                <div class="stat-label">Raw Detections</div>
            </div>
            <div class="stat">
                <div class="stat-value">{len(filtered_detections)}</div>
                <div class="stat-label">Kept Detections</div>
            </div>
            <div class="stat">
                <div class="stat-value">{len(raw_detections) - len(filtered_detections)}</div>
                <div class="stat-label">Filtered Out</div>
            </div>
        </div>

        <div class="legend">
            <div class="legend-item">
                <div class="legend-box kept"></div>
                <span>Kept (Green)</span>
            </div>
            <div class="legend-item">
                <div class="legend-box rejected"></div>
                <span>Rejected (Red)</span>
            </div>
        </div>

        <div class="images">
            <div class="image-container">
                <img src="{base_name}_original.png" alt="Original">
                <div class="image-label">Original Screenshot</div>
            </div>
            <div class="image-container">
                <img src="{base_name}_annotated.png" alt="Annotated">
                <div class="image-label">Annotated (Green=Kept, Red=Rejected)</div>
            </div>
        </div>

        <h2>Detections</h2>
        <div class="detections">
"""

        # Add kept detections
        if filtered_detections:
            html_content += "<h3>✅ Kept Detections</h3>"
            for i, det in enumerate(filtered_detections):
                bbox = det.get('bbox_absolute', {})
                # Format bbox for display
                if isinstance(bbox, dict):
                    bbox_str = f"x={bbox.get('x', 0)}, y={bbox.get('y', 0)}, w={bbox.get('width', 0)}, h={bbox.get('height', 0)}"
                else:
                    bbox_str = ', '.join(map(str, bbox))

                html_content += f"""
                <div class="detection">
                    <div class="detection-header">#{i+1}: {det.get('label', 'unknown')}</div>
                    <div class="detection-info">
                        <strong>Confidence:</strong> {det.get('confidence', 0):.3f}<br>
                        <strong>BBox:</strong> {bbox_str}<br>
                        <strong>Area:</strong> {det.get('relative_area', 0):.4f} (relative)
                    </div>
                </div>
                """

        # Add rejected detections
        rejected = [d for d in raw_detections if d not in filtered_detections]
        if rejected:
            html_content += "<h3>❌ Rejected Detections</h3>"
            for i, det in enumerate(rejected):
                bbox = det.get('bbox_absolute', {})
                # Format bbox for display
                if isinstance(bbox, dict):
                    bbox_str = f"x={bbox.get('x', 0)}, y={bbox.get('y', 0)}, w={bbox.get('width', 0)}, h={bbox.get('height', 0)}"
                else:
                    bbox_str = ', '.join(map(str, bbox))

                rejection_reason = "Unknown"
                if diagnostics.get('filter', {}).get('drop_reasons'):
                    # Try to find rejection reason from diagnostics
                    drop_reasons = diagnostics['filter']['drop_reasons']
                    if drop_reasons:
                        rejection_reason = ', '.join(f"{k}: {v}" for k, v in drop_reasons.items())

                html_content += f"""
                <div class="detection rejected">
                    <div class="detection-header">#{i+1}: {det.get('label', 'unknown')}</div>
                    <div class="detection-info">
                        <strong>Confidence:</strong> {det.get('confidence', 0):.3f}<br>
                        <strong>BBox:</strong> {bbox_str}<br>
                        <strong>Area:</strong> {det.get('relative_area', 0):.4f} (relative)<br>
                        <strong>Rejection Reason:</strong> {rejection_reason}
                    </div>
                </div>
                """

        html_content += f"""
        </div>

        <h2>Filter Diagnostics</h2>
        <div class="json-section">
            <pre>{json.dumps(diagnostics.get('filter', {}), indent=2)}</pre>
        </div>

        <h2>VLM Raw Response</h2>
        <div class="json-section">
            <pre>{response_text[:1000]}</pre>
        </div>

        <h2>Full Data (JSON)</h2>
        <p><a href="{base_name}_data.json" target="_blank">Download JSON</a></p>
    </div>
</body>
</html>
"""

        html_path = debug_dir / f"{base_name}.html"
        with open(html_path, 'w') as f:
            f.write(html_content)

        print(f"✅ VLM Debug saved: {html_path}")
        print(f"   View in browser: file://{html_path.absolute()}")

        return str(html_path.absolute())

    except Exception as e:
        print(f"⚠️ Failed to save VLM debug visualization: {e}")
        import traceback
        traceback.print_exc()
        return None


def detect_elements(
    image: Image.Image,
    query: str,
    viewport_width: int,
    viewport_height: int,
    session_id: Optional[str] = None
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

Return your response as strict JSON in this exact format:
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
- Return ONLY valid JSON (no markdown, no preamble)
- If uncertain, return: {{"detections":[]}}
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
        parsed_detections, parse_diagnostics = parse_claude_response(response_text, viewport_width, viewport_height)
        detections, filter_diagnostics = _filter_detections(
            parsed_detections,
            viewport_width,
            viewport_height,
            query=query,
        )

        latency_ms = int((time.time() - start_time) * 1000)
        diagnostics = {
            "query": query,
            "raw_detection_count": len(parsed_detections),
            "filtered_detection_count": len(detections),
            "parse": parse_diagnostics,
            "filter": filter_diagnostics,
            "thresholds": {
                "min_confidence": VLM_MIN_CONFIDENCE,
                "min_relative_area": VLM_MIN_RELATIVE_AREA,
                "max_relative_area": VLM_MAX_RELATIVE_AREA,
                "max_detections": VLM_MAX_DETECTIONS,
            },
            "raw_response_preview": response_text[:800],
        }

        if VLM_DEBUG_VERBOSE:
            print(
                f"🧪 [VLM] query={query!r} raw={len(parsed_detections)} kept={len(detections)} "
                f"drop_reasons={filter_diagnostics.get('drop_reasons', {})}"
            )
            print(f"🧪 [VLM] parse={parse_diagnostics}")
            for i, det in enumerate(parsed_detections[:5]):
                print(
                    f"🧪 [VLM] raw[{i}] label={det.get('label')} conf={det.get('confidence')} "
                    f"bbox_abs={det.get('bbox_absolute')}"
                )
            if not detections:
                print(f"🧪 [VLM] raw response preview: {response_text[:300]}")
                samples = filter_diagnostics.get("rejected_samples", [])
                if samples:
                    print(f"🧪 [VLM] rejected_samples={samples}")

        # Save debug visualization
        debug_path = save_debug_visualization(
            image=image,
            query=query,
            raw_detections=parsed_detections,
            filtered_detections=detections,
            diagnostics=diagnostics,
            response_text=response_text,
            session_id=session_id,
        )
        if debug_path:
            diagnostics["debug_html_path"] = debug_path

        return {
            "detections": detections,
            "model_latency_ms": latency_ms,
            "reasoning": response_text[:200],  # First 200 chars
            "diagnostics": diagnostics,
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
            "error": str(e),
            "diagnostics": {
                "query": query,
                "raw_detection_count": 0,
                "filtered_detection_count": 0,
                "error": str(e),
            },
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
