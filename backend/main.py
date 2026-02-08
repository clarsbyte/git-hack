import os
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from pydantic import BaseModel
from typing import List, Optional, Dict, Any, Tuple
import json
from dotenv import load_dotenv
from PIL import Image
import io
import asyncio
from contextlib import asynccontextmanager
from time import perf_counter
from session_manager import SessionManager, TutorialPlanState
import base64
import re
from urllib.parse import urlparse
from cerebras.cloud.sdk import Cerebras
from cerebras.cloud.sdk import APIError, APIConnectionError, RateLimitError

# VLM imports - using cloud Claude API
try:
    from vlm_detector_cloud import (
        detect_elements,
        decode_base64_image,
        ensure_vlm_debug_dir,
        initialize_claude,
    )
    VLM_AVAILABLE = True
    print("✅ Using Cloud VLM (Claude API)")
except ImportError as e:
    print(f"⚠️ Cloud VLM dependencies not installed: {e}")
    print("   Install with: pip install anthropic")
    VLM_AVAILABLE = False

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

def _extract_visible_dom_options(dom: Optional[str]) -> List[Tuple[int, str]]:
    """
    Parse indexed DOM text and return visible (index, label) options.
    Expected line shape: [5] a "iPhone 17" ... [VISIBLE]
    """
    if not dom:
        return []
    options: List[Tuple[int, str]] = []
    for line in dom.splitlines():
        if "[VISIBLE]" not in line:
            continue
        match = re.search(r'^\[(\d+)\].*?"([^"]+)"', line)
        if not match:
            continue
        idx = int(match.group(1))
        label = match.group(2).strip()
        if label:
            options.append((idx, label))
    return options

def _infer_topic_from_message(message: str) -> str:
    lower = (message or "").lower()

    quoted = re.search(r'"([^"]+)"', message or "")
    if quoted:
        first = re.findall(r"[a-z0-9]+", quoted.group(1).lower())
        if first:
            return first[0]

    tokens = re.findall(r"[a-z0-9]+", lower)
    stop = {
        "how", "to", "buy", "purchase", "order", "get", "help", "me", "a", "an", "the",
        "and", "or", "with", "for", "on", "in", "from", "model", "models", "this", "that",
    }
    for token in tokens:
        if len(token) < 3:
            continue
        if token in stop:
            continue
        return token
    return ""

def _is_purchase_request(message: str) -> bool:
    lower = message.lower()
    purchase_terms = (
        "buy",
        "purchase",
        "order",
        "get ",
        "shop for",
        "check out",
    )
    return any(term in lower for term in purchase_terms)

def _extract_visible_dom_candidates(dom: Optional[str]) -> List[Dict[str, Any]]:
    """
    Parse indexed DOM lines with visibility and basic interactivity metadata.
    """
    if not dom:
        return []

    candidates: List[Dict[str, Any]] = []
    for line in dom.splitlines():
        if "[VISIBLE]" not in line:
            continue
        match = re.match(r'^\[(\d+)\]\s+([^\s]+)\s+(.*)$', line.strip())
        if not match:
            continue

        idx = int(match.group(1))
        raw_tag = match.group(2)
        tag = raw_tag.split("[", 1)[0].lower()
        rest = match.group(3)
        text_match = re.search(r'"([^"]+)"', rest)
        label = text_match.group(1).strip() if text_match else ""
        aria_label_match = re.search(r'aria-label="([^"]+)"', line)
        a11y_name_match = re.search(r'a11y-name="([^"]+)"', line)
        placeholder_match = re.search(r'placeholder="([^"]+)"', line)
        name_match = re.search(r'name="([^"]+)"', line)
        type_match = re.search(r'\btype="([^"]+)"', line)
        role_match = re.search(r'\brole="([^"]+)"', line)
        bbox_match = re.search(r'\bbbox="(-?\d+),(-?\d+),(\d+),(\d+)"', line)
        screen_bbox_match = re.search(r'\bscreen-bbox="(-?\d+),(-?\d+),(\d+),(\d+)"', line)
        path_match = re.search(r'path="([^"]+)"', line)
        role_path_match = re.search(r'role-path="([^"]+)"', line)
        has_href = 'href="' in line
        role = role_match.group(1).strip().lower() if role_match else ""
        input_type = type_match.group(1).strip().lower() if type_match else ""
        role_button = role in {"button", "link", "menuitem"}
        role_inputish = role in {"textbox", "searchbox", "combobox", "spinbutton"}
        is_interactive = tag in {"a", "button", "input", "select", "textarea", "summary"} or has_href or role_button or role_inputish
        is_container = tag in {"div", "ul", "li", "section", "main", "article", "nav"}
        is_inputish = tag in {"input", "textarea", "select"} or role_inputish
        is_buttonish = tag == "button" or role == "button" or (tag == "input" and input_type in {"submit", "button", "reset"})
        is_linkish = tag == "a" or has_href or role == "link"
        combined = " ".join([
            label,
            aria_label_match.group(1).strip() if aria_label_match else "",
            a11y_name_match.group(1).strip() if a11y_name_match else "",
            placeholder_match.group(1).strip() if placeholder_match else "",
            name_match.group(1).strip() if name_match else "",
            role,
            input_type,
            path_match.group(1).strip() if path_match else "",
            role_path_match.group(1).strip() if role_path_match else "",
        ]).strip().lower()
        bbox_abs = None
        # Prefer desktop/screen-space bbox when available so VLM detections from
        # full-desktop screenshots map in the same coordinate system.
        selected_bbox = screen_bbox_match or bbox_match
        bbox_source = "screen" if screen_bbox_match else ("viewport" if bbox_match else "")
        if selected_bbox:
            bbox_x = int(selected_bbox.group(1))
            bbox_y = int(selected_bbox.group(2))
            bbox_w = int(selected_bbox.group(3))
            bbox_h = int(selected_bbox.group(4))
            if bbox_w > 0 and bbox_h > 0:
                bbox_abs = {
                    "x": bbox_x,
                    "y": bbox_y,
                    "width": bbox_w,
                    "height": bbox_h,
                }
        candidates.append({
            "index": idx,
            "tag": tag,
            "label": label,
            "line": line,
            "has_href": has_href,
            "is_interactive": is_interactive,
            "is_container": is_container,
            "role": role,
            "type": input_type,
            "aria_label": aria_label_match.group(1).strip() if aria_label_match else "",
            "a11y_name": a11y_name_match.group(1).strip() if a11y_name_match else "",
            "placeholder": placeholder_match.group(1).strip() if placeholder_match else "",
            "name": name_match.group(1).strip() if name_match else "",
            "path": path_match.group(1).strip() if path_match else "",
            "role_path": role_path_match.group(1).strip() if role_path_match else "",
            "bbox_absolute": bbox_abs,
            "bbox_source": bbox_source,
            "is_inputish": is_inputish,
            "is_buttonish": is_buttonish,
            "is_linkish": is_linkish,
            "combined_text": combined,
        })

    return candidates


def _is_sticky_or_global_nav_candidate(candidate: Dict[str, Any]) -> bool:
    """Heuristic flag for sticky/global nav controls that often duplicate in-page CTAs."""
    if not isinstance(candidate, dict):
        return False

    text = " ".join([
        str(candidate.get("line", "")),
        str(candidate.get("path", "")),
        str(candidate.get("role_path", "")),
        str(candidate.get("aria_label", "")),
        str(candidate.get("label", "")),
    ]).lower()
    tag = str(candidate.get("tag", "")).lower()
    role = str(candidate.get("role", "")).lower()
    box = candidate.get("bbox_absolute") if isinstance(candidate.get("bbox_absolute"), dict) else {}
    y = float(box.get("y", 9999) or 9999)
    width = float(box.get("width", 0) or 0)

    nav_hints = (
        "sticky",
        "fixed",
        "globalnav",
        "global-nav",
        "subnav",
        "sub-nav",
        "masthead",
        "top-nav",
        "header",
        "navigation",
    )
    has_nav_hint = any(h in text for h in nav_hints)
    top_header_like = y <= 170 and (tag in {"nav", "header"} or role in {"navigation", "menubar"} or width >= 700)
    return bool(has_nav_hint or top_header_like)


def _is_explicit_nav_request(instruction: str) -> bool:
    lower = (instruction or "").lower()
    nav_terms = (
        "nav",
        "navigation",
        "menu",
        "header",
        "sticky bar",
        "top bar",
        "subnav",
    )
    return any(term in lower for term in nav_terms)


def _customer_pov_penalty(candidate: Dict[str, Any], instruction: str) -> float:
    """
    In customer POV mode, avoid selecting sticky/global nav duplicates unless
    the instruction explicitly asks for nav/header UI.
    """
    if _is_explicit_nav_request(instruction):
        return 0.0
    return 95.0 if _is_sticky_or_global_nav_candidate(candidate) else 0.0

def _pick_specific_model_candidate(candidates: List[Dict[str, Any]], topic: str) -> Optional[Tuple[int, str]]:
    """
    Prefer specific clickable model choices over broad container labels.
    """
    if not candidates:
        return None

    scoped = candidates
    if topic:
        topic_scoped = [c for c in candidates if topic in str(c.get("label", "")).lower()]
        if topic_scoped:
            scoped = topic_scoped

    ranked: List[Tuple[float, int, str]] = []
    for c in scoped:
        label = str(c.get("label", "")).strip()
        if not label:
            continue
        if len(label) > 42:
            continue
        word_count = len(label.split())
        if word_count > 7:
            continue

        lower = label.lower()
        generic_words = ("explore", "shop all", "all ", "compare", "learn more")
        if any(g in lower for g in generic_words):
            continue

        score = 0.0
        if c.get("is_interactive"):
            score += 40
        if c.get("tag") == "a":
            score += 20
        if c.get("has_href"):
            score += 15

        nums = [int(n) for n in re.findall(r'\b(\d+)\b', label)]
        if nums:
            score += 100 + max(nums)

        if any(k in lower for k in ("pro max", "pro", "plus", "air", "ultra", "mini")):
            score += 35

        if topic and topic in lower:
            score += 25

        score -= len(label) * 0.15
        score -= word_count * 1.5

        ranked.append((score, int(c["index"]), label))

    if not ranked:
        return None

    ranked.sort(key=lambda t: (-t[0], len(t[2])))
    return (ranked[0][1], ranked[0][2])

def _is_model_selection_text(text: str) -> bool:
    lower = (text or "").lower()
    return "model" in lower and any(k in lower for k in ("select", "choose", "pick"))

def _is_specific_model_label(label: str, topic: str) -> bool:
    lower = label.strip().lower()
    if not lower:
        return False
    if topic and topic not in lower:
        return False
    has_number = re.search(r'\b\d+\b', lower) is not None
    has_variant = any(k in lower for k in ("pro max", "pro", "plus", "air", "mini", "ultra", "max", "se"))
    return has_number or has_variant

def _choose_best_model_candidate(
    candidates: List[Dict[str, Any]],
    topic: str,
    prefer_specific_model: bool
) -> Optional[Tuple[int, str]]:
    if not candidates:
        return None

    scoped = candidates
    if topic:
        topic_scoped = [c for c in candidates if topic in str(c.get("label", "")).lower()]
        if topic_scoped:
            scoped = topic_scoped

    ranked: List[Tuple[float, int, str]] = []
    for c in scoped:
        label = str(c.get("label", "")).strip()
        if not label:
            continue
        score = _score_candidate_for_instruction(c, f"select {topic} model", "select")
        lower = label.lower()

        if prefer_specific_model:
            if topic and lower == topic:
                score -= 220
            if _is_specific_model_label(label, topic):
                score += 220

        ranked.append((score, int(c.get("index", -1)), label))

    if not ranked:
        return None

    ranked.sort(key=lambda t: (-t[0], len(t[2])))
    best = ranked[0]
    if best[1] < 0:
        return None
    return (best[1], best[2])

def _rewrite_first_generic_model_line(text: str, chosen_label: str) -> str:
    if not text or not chosen_label:
        return text
    lines = text.splitlines()
    updated = False
    for i, line in enumerate(lines):
        lower = line.lower()
        if "model" in lower and any(k in lower for k in ("select", "browse", "choose", "explore", "look")):
            prefix_match = re.match(r'^(\s*\d+\.\s*)', line)
            prefix = prefix_match.group(1) if prefix_match else ""
            lines[i] = f'{prefix}Select "{chosen_label}"'
            updated = True
            break
    return "\n".join(lines) if updated else text

def _refine_highlights_to_specific_model(
    highlights: List[Dict[str, Any]],
    dom: Optional[str],
    topic: str,
    response_text: str
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    if not isinstance(highlights, list) or len(highlights) == 0:
        return highlights, None

    candidates = _extract_visible_dom_candidates(dom)
    prefer_specific_model = _is_model_selection_text(response_text)
    best = _choose_best_model_candidate(candidates, topic, prefer_specific_model)
    if not best:
        best = _pick_specific_model_candidate(candidates, topic)
    if not best:
        return highlights, None

    best_idx, best_label = best
    by_index = {int(c["index"]): c for c in candidates}

    first = highlights[0]
    if not isinstance(first, dict):
        return highlights, None

    current_idx = first.get("elementIndex")
    current_info = by_index.get(int(current_idx)) if isinstance(current_idx, int) else None
    explanation = str(first.get("explanation", "")).lower()
    generic_text = "model" in response_text.lower() and any(k in response_text.lower() for k in ("browse", "select", "choose", "explore"))
    current_is_too_generic = (
        ("model" in explanation or "explore" in explanation or "browse" in explanation)
        or (current_info is not None and (not current_info.get("is_interactive") or current_info.get("is_container")))
        or (prefer_specific_model and topic and current_info is not None and str(current_info.get("label", "")).strip().lower() == topic)
    )

    if generic_text or current_is_too_generic:
        first["elementIndex"] = best_idx
        first["explanation"] = f'Select "{best_label}"'
        print(f'🎯 [highlight-refine] switched first highlight -> index {best_idx} "{best_label}"')
        return highlights, best_label

    return highlights, None

def _extract_numbered_steps_from_text(text: str) -> List[str]:
    steps: List[str] = []
    if not text:
        return steps
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = re.match(r'^\d+[.)]\s+(.*)$', stripped)
        if match:
            steps.append(match.group(1).strip())
    return steps

def _render_numbered_steps(steps: List[str]) -> str:
    return "\n".join(f"{i + 1}. {step}" for i, step in enumerate(steps))

def _infer_expected_control_from_instruction(instruction: str) -> str:
    lower = (instruction or "").lower()
    if not lower:
        return "any"

    # Action verbs should win over noun-like tokens to avoid misclassifying
    # click steps containing words like "iPhone" as input steps.
    if any(k in lower for k in ("click", "tap", "press", "buy", "add to", "checkout", "submit", "place order", "continue")):
        return "button"
    if any(k in lower for k in ("open ", "go to", "navigate", "visit ", "link", " tab", "menu item")):
        return "link"
    if any(k in lower for k in ("select ", "choose ", "pick ")):
        return "select"

    input_patterns = [
        r"\btype\b",
        r"\benter\b",
        r"\bfill\b",
        r"\binput\b",
        r"\bsearch\b",
        r"\bemail\b",
        r"\bpassword\b",
        r"\busername\b",
        r"\baddress\b",
        r"\bzip\b",
        r"\bpostal\b",
        r"\bphone\b",
        r"\bphone number\b",
        r"\bname\b",
        r"\bcode\b",
    ]
    if any(re.search(pattern, lower) for pattern in input_patterns):
        return "input"
    return "any"

_SYNONYM_MAP: Dict[str, List[str]] = {
    "proceed": ["next", "continue", "forward"],
    "next": ["proceed", "continue", "forward"],
    "continue": ["next", "proceed", "forward"],
    "submit": ["send", "done", "confirm", "apply"],
    "send": ["submit", "done", "confirm"],
    "cancel": ["close", "dismiss", "discard"],
    "close": ["cancel", "dismiss", "exit"],
    "save": ["apply", "confirm", "done", "update"],
    "confirm": ["ok", "yes", "accept", "approve", "save", "submit"],
    "ok": ["confirm", "yes", "accept", "okay"],
    "delete": ["remove", "trash", "discard", "erase"],
    "remove": ["delete", "trash", "discard"],
    "edit": ["modify", "change", "update"],
    "update": ["edit", "modify", "change", "save"],
    "search": ["find", "lookup", "filter"],
    "find": ["search", "lookup", "filter"],
    "login": ["signin", "sign", "log"],
    "signin": ["login", "sign", "log"],
    "signup": ["register", "create", "join"],
    "register": ["signup", "create", "join"],
    "buy": ["purchase", "order", "checkout", "add"],
    "purchase": ["buy", "order", "checkout"],
    "add": ["create", "new", "insert", "plus"],
    "create": ["add", "new", "make"],
    "settings": ["preferences", "options", "config"],
    "preferences": ["settings", "options", "config"],
    "back": ["return", "previous"],
    "previous": ["back", "return", "prior"],
    "start": ["begin", "launch", "go"],
    "begin": ["start", "launch", "go"],
    "finish": ["complete", "done", "end"],
    "complete": ["finish", "done", "end"],
    "accept": ["agree", "confirm", "ok", "yes"],
    "decline": ["reject", "deny", "no"],
    "expand": ["show", "open", "more", "details"],
    "collapse": ["hide", "less", "close"],
    "download": ["export", "save"],
    "upload": ["import", "attach"],
}

def _expand_with_synonyms(tokens: List[str]) -> List[str]:
    expanded = set(tokens)
    for t in tokens:
        synonyms = _SYNONYM_MAP.get(t, [])
        for s in synonyms:
            expanded.add(s)
    return list(expanded)

def _tokenize_for_matching(text: str) -> List[str]:
    tokens = re.findall(r'[a-z0-9]+', text.lower())
    stop = {"click", "tap", "press", "select", "choose", "enter", "type", "the", "a", "an", "to", "for", "on", "and", "or", "button", "link"}
    return [t for t in tokens if len(t) > 2 and t not in stop]

def _score_candidate_for_instruction(candidate: Dict[str, Any], instruction: str, expected: str) -> float:
    score = 0.0
    if not candidate:
        return -999.0
    if candidate.get("is_interactive"):
        score += 15
    elif expected != "any":
        score -= 120

    # Control-type fit
    if expected == "input":
        if candidate.get("is_inputish"):
            score += 90
        elif candidate.get("is_buttonish") or candidate.get("is_linkish"):
            score -= 60
        else:
            score -= 45
    elif expected == "button":
        if candidate.get("is_buttonish"):
            score += 90
        elif candidate.get("is_linkish"):
            score += 35
        elif candidate.get("is_inputish"):
            score -= 40
        else:
            score -= 30
    elif expected == "link":
        if candidate.get("is_linkish"):
            score += 90
        elif candidate.get("is_buttonish"):
            score += 15
        elif candidate.get("is_inputish"):
            score -= 45
        else:
            score -= 30
    elif expected == "select":
        if candidate.get("tag") == "select" or candidate.get("role") in {"listbox", "option", "combobox"}:
            score += 85
        elif candidate.get("is_linkish") or candidate.get("is_buttonish"):
            score += 45
        elif candidate.get("is_inputish"):
            score += 25
        else:
            score -= 35

    combined = str(candidate.get("combined_text", "")).lower()
    label = str(candidate.get("label", "")).lower()
    tokens = _tokenize_for_matching(instruction)
    match_count = sum(1 for t in tokens if t in combined)
    score += match_count * 12

    # Guardrail: when instruction has explicit keywords (e.g., "iphone"),
    # do not pick unrelated controls just because they are link/button-like.
    # Try synonym expansion before applying the penalty.
    if tokens and match_count == 0:
        expanded_tokens = _expand_with_synonyms(tokens)
        synonym_only = [t for t in expanded_tokens if t not in tokens]
        synonym_match_count = sum(1 for t in synonym_only if t in combined)
        if synonym_match_count == 0:
            score -= 140
        else:
            # Partial credit for synonym matches
            score += synonym_match_count * 8

    normalized_instruction = instruction.strip().lower()
    if normalized_instruction and normalized_instruction in label:
        score += 50
    if label and normalized_instruction == label:
        score += 70

    # Model-selection guardrail: prefer concrete model labels over generic topic links.
    model_intent = _is_model_selection_text(instruction)
    topic = _infer_topic_from_message(instruction)
    if model_intent and topic:
        if label.strip() == topic:
            score -= 220
        elif _is_specific_model_label(label, topic):
            score += 220

    if candidate.get("is_container") and not candidate.get("is_buttonish") and not candidate.get("is_inputish") and not candidate.get("is_linkish"):
        score -= 120
    if len(label) > 50:
        score -= 15
    score -= _customer_pov_penalty(candidate, instruction)

    return score

def _matches_expected_control(candidate: Dict[str, Any], expected: str) -> bool:
    if expected == "input":
        return bool(candidate.get("is_inputish"))
    if expected == "button":
        return bool(candidate.get("is_buttonish") or candidate.get("is_linkish"))
    if expected == "link":
        return bool(candidate.get("is_linkish"))
    if expected == "select":
        return bool(
            candidate.get("tag") == "select"
            or candidate.get("role") in {"listbox", "option", "combobox"}
            or candidate.get("is_linkish")
            or candidate.get("is_buttonish")
        )
    return bool(candidate.get("is_interactive"))

def _explanation_for_expected_control(expected: str, chosen_label: str) -> str:
    if expected == "input":
        return f'Type into "{chosen_label}"'
    if expected == "link":
        return f'Open "{chosen_label}"'
    if expected == "select":
        return f'Select "{chosen_label}"'
    return f'Click "{chosen_label}"'


def _apply_vlm_first_highlight_selection(
    highlights: List[Dict[str, Any]],
    vlm_mapped: List[Dict[str, Any]],
    dom: Optional[str],
    instruction_hints: List[str],
    action_hints: Optional[List[str]] = None,
) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Prefer VLM-mapped DOM candidates as the source of truth for step targets.
    This avoids the "pick twice" behavior where heuristics choose one element
    first and VLM overrides it later.
    """
    if not isinstance(highlights, list) or not highlights:
        return highlights, False
    if not isinstance(vlm_mapped, list) or not vlm_mapped:
        return highlights, False

    candidates = _extract_visible_dom_candidates(dom)
    if not candidates:
        return highlights, False

    by_index = {int(c["index"]): c for c in candidates if c.get("index") is not None}
    mapped_scored: List[Tuple[float, Dict[str, Any], Dict[str, Any]]] = []
    for item in vlm_mapped:
        try:
            idx = int(item.get("dom_index"))
        except (TypeError, ValueError):
            continue
        cand = by_index.get(idx)
        if not cand:
            continue
        mapped_scored.append((float(item.get("score", 0.0) or 0.0), item, cand))

    if not mapped_scored:
        return highlights, False

    changed = False
    used_indices: set[int] = set()
    for i, h in enumerate(highlights):
        if not isinstance(h, dict):
            continue

        hint = instruction_hints[i] if i < len(instruction_hints) else str(h.get("explanation", "")).strip()
        if not hint:
            hint = ""

        expected = _infer_expected_control_from_instruction(hint)
        if expected == "any" and isinstance(action_hints, list) and i < len(action_hints):
            action_hint = str(action_hints[i]).strip().lower()
            if action_hint in {"click", "navigate"}:
                expected = "button"
            elif action_hint == "input":
                expected = "input"

        hint_tokens = _tokenize_instruction_for_vlm(hint)
        best_total = float("-inf")
        best_item: Optional[Dict[str, Any]] = None
        best_candidate: Optional[Dict[str, Any]] = None
        for base_score, item, cand in mapped_scored:
            idx = int(cand.get("index", -1))
            if idx < 0:
                continue
            dom_label = str(cand.get("label", "")).lower()
            det_label = str(item.get("det_label", "")).lower()
            token_hits = sum(1 for t in hint_tokens if t in dom_label or t in det_label)

            total = base_score + (token_hits * 22.0)
            if expected != "any":
                total += 48.0 if _matches_expected_control(cand, expected) else -90.0
            if cand.get("is_interactive"):
                total += 8.0
            total -= _customer_pov_penalty(cand, hint)
            if idx in used_indices and len(mapped_scored) > 1:
                total -= 25.0

            if total > best_total:
                best_total = total
                best_item = item
                best_candidate = cand

        if not best_item or not best_candidate:
            continue

        chosen_idx = int(best_candidate.get("index", -1))
        if chosen_idx < 0:
            continue
        chosen_label = str(best_candidate.get("label") or best_item.get("det_label") or f"Element {chosen_idx}")

        prev_idx = h.get("elementIndex")
        if not isinstance(prev_idx, int) or prev_idx != chosen_idx:
            h["elementIndex"] = chosen_idx
            h["explanation"] = _explanation_for_expected_control(expected, chosen_label) if expected != "any" else f'Select "{chosen_label}"'
            h["selectionReason"] = (
                f'VLM-first selection: step matched to "{chosen_label}" '
                f'(elementIndex={chosen_idx}, score={best_item.get("score")}, iou={best_item.get("iou")}).'
            )
            changed = True
        used_indices.add(chosen_idx)

    return highlights, changed


def _refine_highlights_to_control_type(
    highlights: List[Dict[str, Any]],
    dom: Optional[str],
    instruction_hints: List[str],
    action_hints: Optional[List[str]] = None
) -> Tuple[List[Dict[str, Any]], List[str], bool]:
    if not isinstance(highlights, list) or not highlights:
        return highlights, instruction_hints, False

    candidates = _extract_visible_dom_candidates(dom)
    if not candidates:
        return highlights, instruction_hints, False

    by_index = {int(c["index"]): c for c in candidates}
    changed = False
    updated_steps = list(instruction_hints)

    for i, highlight in enumerate(highlights):
        if not isinstance(highlight, dict):
            continue

        hint = ""
        if i < len(instruction_hints):
            hint = instruction_hints[i]
        if not hint:
            hint = str(highlight.get("explanation", "")).strip()
        if not hint:
            continue

        expected = _infer_expected_control_from_instruction(hint)
        if expected == "any" and isinstance(action_hints, list) and i < len(action_hints):
            action_hint = str(action_hints[i]).strip().lower()
            if action_hint in {"click", "navigate"}:
                expected = "button"
            elif action_hint == "input":
                expected = "input"
        if expected == "any":
            continue

        current_idx = highlight.get("elementIndex")
        current = by_index.get(int(current_idx)) if isinstance(current_idx, int) else None
        current_score = _score_candidate_for_instruction(current, hint, expected) if current else -999.0

        ranked: List[Tuple[float, Dict[str, Any]]] = []
        scoped_candidates = [c for c in candidates if _matches_expected_control(c, expected) and c.get("is_interactive")]
        if not scoped_candidates:
            scoped_candidates = candidates
        for c in scoped_candidates:
            ranked.append((_score_candidate_for_instruction(c, hint, expected), c))
        ranked.sort(key=lambda t: t[0], reverse=True)
        best_score, best = ranked[0]

        if best_score < 45:
            continue
        if current is None or (best_score >= current_score + 20):
            chosen_idx = int(best["index"])
            chosen_label = str(best.get("label") or best.get("aria_label") or best.get("placeholder") or f"Element {chosen_idx}")
            highlight["elementIndex"] = chosen_idx
            highlight["explanation"] = _explanation_for_expected_control(expected, chosen_label)
            if i < len(updated_steps) and expected in {"input", "button", "link", "select"}:
                verb = {"input": "Type into", "button": "Click", "link": "Open", "select": "Select"}[expected]
                updated_steps[i] = f'{verb} "{chosen_label}"'
            print(f'🎛️ [control-refine] step {i + 1}: expected={expected} -> index {chosen_idx} "{chosen_label}"')
            changed = True

    return highlights, updated_steps, changed

def _pick_default_visible_option(options: List[Tuple[int, str]], topic: str) -> Optional[Tuple[int, str]]:
    """
    Pick a concrete default option from visible DOM labels.
    Priority:
    1) Topic-containing options (if topic exists)
    2) Highest model number (e.g. iPhone 17 over iPhone 16)
    3) Shortest precise label (least extra words)
    """
    if not options:
        return None

    scoped = options
    if topic:
        topic_scoped = [(idx, label) for idx, label in options if topic in label.lower()]
        if topic_scoped:
            scoped = topic_scoped

    numbered: List[Tuple[int, str, int]] = []
    for idx, label in scoped:
        nums = [int(n) for n in re.findall(r'\b(\d+)\b', label)]
        if nums:
            numbered.append((idx, label, max(nums)))

    if numbered:
        numbered.sort(key=lambda t: (-t[2], len(t[1])))
        idx, label, _ = numbered[0]
        return (idx, label)

    scoped.sort(key=lambda t: len(t[1]))
    return scoped[0]

def _pick_topic_label(options: List[Tuple[int, str]], topic: str) -> str:
    if topic:
        for _, label in options:
            if label.strip().lower() == topic:
                return label.strip()
    return topic.title() if topic else "Product"

def _pick_topic_option(options: List[Tuple[int, str]], topic: str) -> Optional[Tuple[int, str]]:
    if not topic:
        return None
    for idx, label in options:
        if label.strip().lower() == topic:
            return (idx, label.strip())
    return None

def _pick_requested_or_default_option(
    options: List[Tuple[int, str]],
    message: str,
    topic: str
) -> Optional[Tuple[int, str]]:
    if not options:
        return None

    lower_message = message.lower()
    topic_scoped = options
    if topic:
        filtered = [(idx, label) for idx, label in options if topic in label.lower()]
        if filtered:
            topic_scoped = filtered

    exact = [(idx, label) for idx, label in topic_scoped if label.lower() in lower_message]
    if exact:
        exact.sort(key=lambda t: len(t[1]))
        return exact[0]

    return _pick_default_visible_option(topic_scoped, topic)

def _build_purchase_flow_plan(
    tutorial_plan_data: Dict[str, Any],
    dom: Optional[str],
    message: str
) -> Dict[str, Any]:
    if not isinstance(tutorial_plan_data, dict):
        return tutorial_plan_data

    if not _is_purchase_request(message):
        return tutorial_plan_data

    topic = _infer_topic_from_message(message)
    if not topic:
        return tutorial_plan_data

    visible_options = _extract_visible_dom_options(dom)
    topic_option = _pick_topic_option(visible_options, topic)
    topic_label = topic_option[1] if topic_option else _pick_topic_label(visible_options, topic)
    model_option = _pick_requested_or_default_option(visible_options, message, topic)
    if not model_option:
        return tutorial_plan_data

    model_idx, model_label = model_option
    flow_steps = [
        {
            "stepNumber": 1,
            "instruction": f'Click "{topic_label}"',
            "actionType": "click",
            "expectsPageChange": True,
            "pageDescription": f"{topic_label} category page",
            "isTerminal": False,
        },
        {
            "stepNumber": 2,
            "instruction": f'Click "{model_label}"',
            "actionType": "click",
            "expectsPageChange": True,
            "pageDescription": f"{model_label} product page",
            "isTerminal": False,
        },
        {
            "stepNumber": 3,
            "instruction": f'Confirm you are on the buy page for "{model_label}"',
            "actionType": "wait",
            "expectsPageChange": False,
            "pageDescription": "Buy page confirmation",
            "isTerminal": True,
        },
    ]

    tutorial_plan_data["planSteps"] = flow_steps
    tutorial_plan_data["totalSteps"] = 3
    tutorial_plan_data["title"] = tutorial_plan_data.get("title") or f"Buy {topic_label}"
    tutorial_plan_data["textOverride"] = "\n".join(
        f'{step["stepNumber"]}. {step["instruction"]}'
        for step in flow_steps
    )

    tutorial_plan_data["currentPageHighlights"] = [
        {
            "elementIndex": topic_option[0] if topic_option else model_idx,
            "explanation": f'Click "{topic_label}"',
            "planStepNumber": 1,
        }
    ]
    tutorial_plan_data["currentPageRange"] = {"startIndex": 0, "endIndex": 0}
    return tutorial_plan_data

def _is_generic_model_step(instruction: str) -> bool:
    lower = instruction.lower()
    if "model" not in lower and "models" not in lower:
        return False
    generic_markers = ("browse", "look through", "different", "explore", "choose one", "pick one")
    return any(marker in lower for marker in generic_markers)

def _de_generic_tutorial_plan(
    tutorial_plan_data: Dict[str, Any],
    dom: Optional[str],
    message: str
) -> Dict[str, Any]:
    """
    Convert vague model-browsing instructions into concrete DOM-grounded actions.
    """
    plan_steps = tutorial_plan_data.get("planSteps", [])
    if not isinstance(plan_steps, list) or not plan_steps:
        return tutorial_plan_data

    visible_options = _extract_visible_dom_options(dom)
    topic = _infer_topic_from_message(message)
    default_option = _pick_default_visible_option(visible_options, topic)
    if not default_option:
        return tutorial_plan_data

    default_idx, default_label = default_option
    changed = False

    for step in plan_steps:
        if not isinstance(step, dict):
            continue
        instruction = str(step.get("instruction", "")).strip()
        if not instruction:
            continue
        if _is_generic_model_step(instruction):
            step["instruction"] = f'Click "{default_label}" to continue.'
            step["actionType"] = "click"
            changed = True

    if changed:
        current_highlights = tutorial_plan_data.get("currentPageHighlights")
        if isinstance(current_highlights, list) and len(current_highlights) > 0:
            first = current_highlights[0]
            if isinstance(first, dict):
                first["elementIndex"] = default_idx
                first["explanation"] = f'Select "{default_label}"'

        tutorial_plan_data["planSteps"] = plan_steps
        tutorial_plan_data["textOverride"] = "\n".join(
            f'{i + 1}. {str(step.get("instruction", "")).strip()}'
            for i, step in enumerate(plan_steps)
            if isinstance(step, dict) and str(step.get("instruction", "")).strip()
        )
        print(f'🛠️ [tutorial-plan] Replaced generic model step(s) with concrete option: "{default_label}" (index {default_idx})')

    return tutorial_plan_data

def _normalize_action_type(action_type: str, instruction: str) -> str:
    normalized = str(action_type or "").strip().lower()
    if normalized in {"click", "input", "wait", "navigate", "scroll", "observe"}:
        return normalized
    inferred = _infer_expected_control_from_instruction(instruction)
    if inferred == "input":
        return "input"
    if inferred == "link":
        return "navigate"
    if inferred == "select":
        return "click"
    return "click"

def _normalize_tutorial_plan_schema(tutorial_plan_data: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(tutorial_plan_data, dict):
        return tutorial_plan_data

    raw_steps = tutorial_plan_data.get("planSteps", [])
    if not isinstance(raw_steps, list):
        raw_steps = []

    normalized_steps: List[Dict[str, Any]] = []
    for i, raw_step in enumerate(raw_steps):
        if not isinstance(raw_step, dict):
            continue

        instruction = str(raw_step.get("instruction", "")).strip()
        if not instruction:
            continue

        action_type = _normalize_action_type(str(raw_step.get("actionType", "")), instruction)

        expects_page_change_raw = raw_step.get("expectsPageChange")
        expects_page_change = bool(expects_page_change_raw) if isinstance(expects_page_change_raw, bool) else (action_type == "navigate")

        normalized_steps.append({
            "stepNumber": len(normalized_steps) + 1,
            "instruction": instruction,
            "actionType": action_type,
            "expectsPageChange": expects_page_change,
            "pageDescription": str(raw_step.get("pageDescription", "")).strip(),
            "isTerminal": False,
        })

    if not normalized_steps:
        tutorial_plan_data["planSteps"] = []
        tutorial_plan_data["totalSteps"] = 0
        tutorial_plan_data["currentPageRange"] = {"startIndex": 0, "endIndex": 0}
        tutorial_plan_data["currentPageHighlights"] = []
        return tutorial_plan_data

    normalized_steps[-1]["isTerminal"] = True
    tutorial_plan_data["planSteps"] = normalized_steps
    tutorial_plan_data["totalSteps"] = len(normalized_steps)

    current_range = tutorial_plan_data.get("currentPageRange", {})
    if not isinstance(current_range, dict):
        current_range = {}
    start_idx = int(current_range.get("startIndex", 0)) if str(current_range.get("startIndex", "0")).isdigit() else 0
    end_idx = int(current_range.get("endIndex", start_idx)) if str(current_range.get("endIndex", str(start_idx))).isdigit() else start_idx
    start_idx = max(0, min(start_idx, len(normalized_steps) - 1))
    end_idx = max(start_idx, min(end_idx, len(normalized_steps) - 1))
    tutorial_plan_data["currentPageRange"] = {"startIndex": start_idx, "endIndex": end_idx}

    highlights = tutorial_plan_data.get("currentPageHighlights", [])
    if not isinstance(highlights, list):
        highlights = []
    for i, highlight in enumerate(highlights):
        if not isinstance(highlight, dict):
            continue
        plan_idx = start_idx + i
        if plan_idx < len(normalized_steps) and not isinstance(highlight.get("planStepNumber"), int):
            highlight["planStepNumber"] = normalized_steps[plan_idx]["stepNumber"]
    tutorial_plan_data["currentPageHighlights"] = highlights

    return tutorial_plan_data

def check_network_connectivity(host: str = "api.cerebras.ai") -> dict:
    """Check if the Cerebras API is reachable using the SDK."""
    import socket
    result = {
        "dns_ok": False,
        "https_ok": False,
        "auth_ok": False,
        "dns_error": None,
        "https_error": None,
    }

    # Check DNS
    try:
        ip = socket.gethostbyname(host)
        result["dns_ok"] = True
        result["dns_ip"] = ip
    except socket.gaierror as e:
        result["dns_error"] = f"Cannot resolve {host}: {e}"
        return result

    # Check HTTPS connectivity with authentication using SDK
    if not cerebras_client:
        result["https_error"] = "Cerebras client not initialized"
        return result

    try:
        # Try a simple API call with minimal tokens
        cerebras_client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": "test"}],
            max_tokens=1,
        )
        result["https_ok"] = True
        result["auth_ok"] = True
    except APIConnectionError as e:
        result["https_error"] = f"Connection failed: {e}"
    except APIError as e:
        if "401" in str(e.status_code) or "Unauthorized" in str(e):
            result["https_error"] = f"HTTP 401: Invalid or expired API key"
        elif "403" in str(e.status_code) or "Forbidden" in str(e):
            result["https_error"] = f"HTTP 403: Access forbidden - check account permissions"
            result["https_ok"] = True  # Connection works, auth/permissions fail
        else:
            result["https_error"] = f"API error: {e}"
    except Exception as e:
        result["https_error"] = f"Connection check failed: {e}"

    return result

api_key = os.getenv("CEREBRAS_API_KEY")
if not api_key:
    print("WARNING: CEREBRAS_API_KEY not found in environment variables.")

model_name = "llama-3.3-70b";
max_output_tokens = int(os.getenv("CEREBRAS_MAX_TOKENS", "4096"))
request_timeout = float(os.getenv("CEREBRAS_TIMEOUT", "60"))

# Initialize Cerebras client
cerebras_client = None
if api_key:
    try:
        cerebras_client = Cerebras(api_key=api_key, timeout=request_timeout)
    except Exception as e:
        print(f"WARNING: Failed to initialize Cerebras client: {e}")

def cerebras_chat(messages: list, max_tokens: int, temperature: float = 0.0, stream: bool = False) -> dict:
    """
    Send a chat message to Cerebras API using the official SDK.
    Returns the full response object from the API.
    """
    if not api_key:
        raise RuntimeError("CEREBRAS_API_KEY not configured")

    if not cerebras_client:
        raise RuntimeError("Cerebras client failed to initialize. Check CEREBRAS_API_KEY.")

    try:
        response = cerebras_client.chat.completions.create(
            model=model_name,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=stream,
        )

        # Convert response to dict format for compatibility with existing code
        return {
            "choices": [
                {
                    "message": {
                        "content": response.choices[0].message.content
                    }
                }
            ]
        }

    except APIConnectionError as e:
        error_msg = f"Cerebras connection error: {e}. Check your internet connection."
        print(f"Connection Error: {error_msg}")
        raise RuntimeError(error_msg) from e
    except RateLimitError as e:
        error_msg = f"Cerebras rate limit exceeded. Please wait before retrying."
        print(f"Rate Limit Error: {error_msg}")
        raise RuntimeError(error_msg) from e
    except APIError as e:
        error_msg = f"Cerebras API error {e.status_code}: {e.message}"
        print(f"API Error: {error_msg}")
        raise RuntimeError(error_msg) from e
    except Exception as e:
        error_msg = f"Unexpected error calling Cerebras: {e}"
        print(f"Unexpected Error: {error_msg}")
        raise RuntimeError(error_msg) from e

def extract_cerebras_message(response_json: dict) -> str:
    try:
        return response_json["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return json.dumps(response_json)


def _parse_viewport_dimensions(
    viewport_info: Optional[str],
    fallback_width: int,
    fallback_height: int
) -> Tuple[int, int]:
    """Best-effort parser for viewport width/height from JSON or plain text."""
    width = fallback_width
    height = fallback_height

    if viewport_info:
        try:
            parsed = json.loads(viewport_info)
            if isinstance(parsed, dict):
                key_sets = [
                    ("width", "height"),
                    ("viewportWidth", "viewportHeight"),
                    ("innerWidth", "innerHeight"),
                ]
                for w_key, h_key in key_sets:
                    w_val = parsed.get(w_key)
                    h_val = parsed.get(h_key)
                    if isinstance(w_val, (int, float)) and isinstance(h_val, (int, float)):
                        width = int(w_val)
                        height = int(h_val)
                        break
        except (json.JSONDecodeError, TypeError):
            pass

        width_match = re.search(r'(?i)(?:viewport[_\s-]*width|width)\s*[:=]\s*(\d{2,5})', viewport_info)
        height_match = re.search(r'(?i)(?:viewport[_\s-]*height|height)\s*[:=]\s*(\d{2,5})', viewport_info)
        if width_match:
            width = int(width_match.group(1))
        if height_match:
            height = int(height_match.group(1))

    if width <= 0:
        width = fallback_width
    if height <= 0:
        height = fallback_height
    return width, height


def _tokenize_instruction_for_vlm(text: str) -> List[str]:
    tokens = re.findall(r"[a-z0-9]+", (text or "").lower())
    stop = {
        "click", "tap", "press", "select", "choose", "open", "go", "navigate",
        "enter", "type", "fill", "the", "a", "an", "to", "for", "on", "in",
        "and", "or", "this", "that", "with", "from", "step", "page", "current",
    }
    return [t for t in tokens if len(t) > 2 and t not in stop]


def _rank_vlm_detections(detections: List[Dict[str, Any]], instruction: str) -> List[Dict[str, Any]]:
    query_tokens = _tokenize_instruction_for_vlm(instruction)
    ranked: List[Tuple[float, Dict[str, Any]]] = []

    for det in detections:
        label = str(det.get("label", "")).lower()
        conf = float(det.get("confidence", 0.0) or 0.0)
        bbox_abs = det.get("bbox_absolute", {}) or {}
        area = float((bbox_abs.get("width", 0) or 0) * (bbox_abs.get("height", 0) or 0))

        token_hits = sum(1 for t in query_tokens if t in label)
        exact_label_bonus = 40.0 if label and label in (instruction or "").lower() else 0.0
        conf_score = conf * 100.0
        area_penalty = min(area / 50000.0, 25.0)  # discourage very large generic boxes
        score = (token_hits * 30.0) + exact_label_bonus + conf_score - area_penalty

        ranked.append((score, det))

    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [det for _, det in ranked]


def _safe_box_from_candidate(candidate: Dict[str, Any]) -> Optional[Dict[str, float]]:
    raw = candidate.get("bbox_absolute")
    if not isinstance(raw, dict):
        return None
    try:
        x = float(raw.get("x", 0))
        y = float(raw.get("y", 0))
        width = float(raw.get("width", 0))
        height = float(raw.get("height", 0))
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def _safe_box_from_detection(det: Dict[str, Any]) -> Optional[Dict[str, float]]:
    raw = det.get("bbox_absolute")
    if not isinstance(raw, dict):
        return None
    try:
        x = float(raw.get("x", 0))
        y = float(raw.get("y", 0))
        width = float(raw.get("width", 0))
        height = float(raw.get("height", 0))
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def _bbox_iou(a: Dict[str, float], b: Dict[str, float]) -> float:
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = ax1 + a["width"], ay1 + a["height"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = bx1 + b["width"], by1 + b["height"]

    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0

    union = (a["width"] * a["height"]) + (b["width"] * b["height"]) - inter
    if union <= 0:
        return 0.0
    return inter / union


def _map_vlm_detections_to_dom_indices(
    detections: List[Dict[str, Any]],
    dom_text: Optional[str],
    query: str
) -> List[Dict[str, Any]]:
    dom_candidates = _extract_visible_dom_candidates(dom_text)
    if not dom_candidates:
        return []

    query_tokens = _tokenize_instruction_for_vlm(query)
    mapped: List[Dict[str, Any]] = []
    for det in detections[:5]:
        det_label = str(det.get("label", "")).strip().lower()
        if not det_label:
            continue
        det_box = _safe_box_from_detection(det)

        best_score = float("-inf")
        best_candidate: Optional[Dict[str, Any]] = None
        best_iou = 0.0
        for candidate in dom_candidates:
            idx = int(candidate.get("index", -1))
            if idx < 0:
                continue
            dom_label = str(candidate.get("label", "")).strip()
            dom_lower = dom_label.lower()
            token_hits = sum(1 for t in query_tokens if t in dom_lower)
            label_overlap = 50.0 if det_label in dom_lower or dom_lower in det_label else 0.0
            dom_len_penalty = min(len(dom_lower) / 40.0, 6.0)
            score = (token_hits * 18.0) + label_overlap - dom_len_penalty

            # Primary signal when available: geometric overlap between VLM box and DOM box.
            dom_box = _safe_box_from_candidate(candidate)
            iou_score = 0.0
            if det_box and dom_box:
                iou = _bbox_iou(det_box, dom_box)
                iou_score = iou * 120.0
                score += iou_score
            else:
                iou = 0.0

            if candidate.get("is_interactive"):
                score += 6.0
            score -= _customer_pov_penalty(candidate, query)

            if score > best_score:
                best_score = score
                best_candidate = candidate
                best_iou = iou
        if best_candidate is not None:
            best_idx = int(best_candidate.get("index"))
            best_dom_label = str(best_candidate.get("label", ""))
            method = "geometry+text" if best_iou > 0 else "text-only"
            mapped.append({
                "det_label": det.get("label"),
                "det_bbox_absolute": det.get("bbox_absolute"),
                "det_source_query": det.get("source_query"),
                "dom_index": best_idx,
                "dom_label": best_dom_label,
                "dom_bbox_source": best_candidate.get("bbox_source"),
                "score": round(best_score, 2),
                "iou": round(best_iou, 4),
                "method": method,
            })

    mapped.sort(key=lambda item: item["score"], reverse=True)
    return mapped


def _constrain_highlights_to_vlm_bounds(
    highlights: List[Dict[str, Any]],
    dom_text: Optional[str],
    vlm_detections: List[Dict[str, Any]],
    vlm_mapped: List[Dict[str, Any]],
    iou_threshold: float = 0.0,
) -> List[Dict[str, Any]]:
    """
    Post-process highlights: if VLM detected elements with bounding boxes,
    verify that chosen elementIndices overlap with VLM detections.
    If not, override with VLM's best mapped DOM suggestion.
    """
    if not vlm_detections or not vlm_mapped:
        return highlights
    if not isinstance(highlights, list) or not highlights:
        return highlights

    candidates = _extract_visible_dom_candidates(dom_text)
    by_index = {int(c["index"]): c for c in candidates if c.get("index") is not None}

    # Build VLM detection boxes
    det_boxes = []
    for det in vlm_detections:
        box = _safe_box_from_detection(det)
        if box:
            det_boxes.append(box)

    if not det_boxes:
        return highlights

    result = []
    for h in highlights:
        if not isinstance(h, dict):
            result.append(h)
            continue

        elem_idx = h.get("elementIndex")
        if elem_idx is None:
            result.append(h)
            continue

        candidate = by_index.get(int(elem_idx))
        dom_box = _safe_box_from_candidate(candidate) if candidate else None

        # Check if this element's bbox overlaps with any VLM detection
        overlaps = False
        if dom_box:
            for det_box in det_boxes:
                iou = _bbox_iou(dom_box, det_box)
                if iou > iou_threshold:
                    overlaps = True
                    break

        if overlaps:
            result.append(h)
        else:
            # Override with VLM's best mapped DOM index
            best_mapped = vlm_mapped[0] if vlm_mapped else None
            if best_mapped:
                new_idx = best_mapped.get("dom_index")
                new_label = best_mapped.get("dom_label", "")
                print(
                    f"🎯 [vlm-constrain] elementIndex {elem_idx} has no VLM bbox overlap; "
                    f"overriding -> index {new_idx} \"{new_label}\" "
                    f"(VLM label=\"{best_mapped.get('det_label')}\", iou={best_mapped.get('iou', 0)})"
                )
                h = dict(h)
                h["elementIndex"] = new_idx
                if not h.get("explanation") and new_label:
                    h["explanation"] = f'Select "{new_label}"'
            result.append(h)

    return result


def _annotate_highlights_with_vlm_trace(
    highlights: List[Dict[str, Any]],
    vlm_mapped: List[Dict[str, Any]],
    vlm_detections: List[Dict[str, Any]],
    screenshot_provided: bool = False,
    vlm_context: str = "",
) -> List[Dict[str, Any]]:
    if not isinstance(highlights, list) or not highlights:
        return highlights

    context_payload: Dict[str, Any] = {}
    if isinstance(vlm_context, str) and "VLM_CONTEXT_JSON:" in vlm_context:
        try:
            json_part = vlm_context.split("VLM_CONTEXT_JSON:", 1)[1].strip()
            first_line = json_part.splitlines()[0].strip()
            context_payload = json.loads(first_line) if first_line else {}
            if not isinstance(context_payload, dict):
                context_payload = {}
        except Exception:
            context_payload = {}

    def _format_diag_summary(payload: Dict[str, Any]) -> str:
        if not isinstance(payload, dict):
            return ""
        diagnostics = payload.get("diagnostics")
        diag: Dict[str, Any] = {}
        if isinstance(diagnostics, list) and diagnostics:
            first = diagnostics[0]
            if isinstance(first, dict):
                diag = first
        elif isinstance(diagnostics, dict):
            diag = diagnostics
        if not diag:
            return ""

        raw_count = diag.get("raw_detection_count")
        filtered_count = diag.get("filtered_detection_count")
        filt = diag.get("filter") if isinstance(diag.get("filter"), dict) else {}
        drop_reasons = filt.get("drop_reasons") if isinstance(filt, dict) else {}

        parts: List[str] = []
        if isinstance(raw_count, int) or isinstance(filtered_count, int):
            parts.append(f"raw={raw_count}, filtered={filtered_count}")
        if isinstance(drop_reasons, dict) and drop_reasons:
            nonzero = [(str(k), int(v)) for k, v in drop_reasons.items() if isinstance(v, int) and v > 0]
            if nonzero:
                nonzero.sort(key=lambda kv: kv[1], reverse=True)
                top = ", ".join(f"{k}:{v}" for k, v in nonzero[:3])
                parts.append(f"top_drops={top}")
        return "; ".join(parts)

    if not vlm_detections:
        if not screenshot_provided:
            reason = "VLM not checked: no screenshot was provided for this request."
        else:
            if context_payload.get("error"):
                reason = f'VLM checked: screenshot received, but VLM failed ({context_payload.get("error")}).'
            else:
                q = context_payload.get("query", "")
                count = context_payload.get("detectionCount", 0)
                diag_summary = _format_diag_summary(context_payload)
                suffix = f"; {diag_summary}" if diag_summary else ""
                reason = (
                    f'VLM checked: screenshot received, query="{q}", detections={count} '
                    f"(no usable visual match{suffix})."
                )
        for h in highlights:
            if isinstance(h, dict):
                h["selectionReason"] = reason
        return highlights

    by_dom_index: Dict[int, Dict[str, Any]] = {}
    for item in vlm_mapped:
        try:
            idx = int(item.get("dom_index"))
        except (TypeError, ValueError):
            continue
        existing = by_dom_index.get(idx)
        if existing is None or float(item.get("score", 0.0) or 0.0) > float(existing.get("score", 0.0) or 0.0):
            by_dom_index[idx] = item

    top_mapped = vlm_mapped[0] if vlm_mapped else None

    for h in highlights:
        if not isinstance(h, dict):
            continue
        elem_idx = h.get("elementIndex")
        mapped = None
        if isinstance(elem_idx, int):
            mapped = by_dom_index.get(elem_idx)

        if mapped:
            det_bbox = mapped.get("det_bbox_absolute") if isinstance(mapped.get("det_bbox_absolute"), dict) else {}
            source_query = str(mapped.get("det_source_query", "")).strip()
            h["selectionReason"] = (
                f'VLM checked: picked elementIndex {mapped.get("dom_index")} '
                f'from visual label "{mapped.get("det_label", "")}" '
                f'(bbox={det_bbox}, dom="{mapped.get("dom_label", "")}", '
                f'score={mapped.get("score")}, iou={mapped.get("iou")}, method={mapped.get("method")}, '
                f'query="{source_query}").'
            )
        else:
            if top_mapped:
                top_bbox = top_mapped.get("det_bbox_absolute") if isinstance(top_mapped.get("det_bbox_absolute"), dict) else {}
                h["selectionReason"] = (
                    f'VLM checked: no direct match for this step; used DOM fallback. '
                    f'Best visual candidate was "{top_mapped.get("det_label", "")}" '
                    f'(bbox={top_bbox}, suggestedIndex={top_mapped.get("dom_index")}, '
                    f'score={top_mapped.get("score")}, iou={top_mapped.get("iou")}).'
                )
            else:
                h["selectionReason"] = "VLM checked: no direct match for this step, used DOM fallback."

    return highlights


def _build_vlm_query_for_step(step: Dict[str, Any]) -> Optional[str]:
    if not isinstance(step, dict):
        return None
    instruction = str(step.get("instruction", "")).strip()
    if not instruction:
        return None
    action = str(step.get("actionType", "")).strip().lower() or "click"
    if action == "input":
        expected = "input"
    elif action in {"navigate"}:
        expected = "link"
    elif action in {"click"}:
        expected = "button"
    elif action in {"wait", "observe"}:
        expected = "any"
    else:
        expected = _infer_expected_control_from_instruction(instruction)
    instruction_json = json.dumps(instruction, ensure_ascii=True)
    return (
        f'action={action}; expected_control={expected}; '
        f"target_instruction={instruction_json}"
    )


def _filter_extension_ui_detections(detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filter out Site Tutor extension UI elements from VLM detections."""
    extension_keywords = [
        "site tutor",
        "tutorial step",
        "verify step",
        "click verify",
        "selection logic",
        "keywords:",
        "control type:",
        "guided tutorial",
    ]

    filtered = []
    for det in detections:
        label = str(det.get("label", "")).lower()
        # Skip if label contains extension UI keywords
        if any(keyword in label for keyword in extension_keywords):
            print(f"🧹 [VLM-filter] Skipping extension UI: {det.get('label')}")
            continue
        filtered.append(det)

    return filtered


def _run_vlm_detection_for_query(
    image: Image.Image,
    query: str,
    viewport_width: int,
    viewport_height: int,
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    result = detect_elements(
        image=image,
        query=query,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        session_id=session_id,
    )
    raw_detections = result.get("detections", []) or []
    # Filter out extension UI artifacts before ranking
    clean_detections = _filter_extension_ui_detections(raw_detections)
    detections = _rank_vlm_detections(clean_detections, query)
    diagnostics = result.get("diagnostics", {}) or {}
    if isinstance(diagnostics, dict):
        raw_count = diagnostics.get("raw_detection_count")
        filtered_count = diagnostics.get("filtered_detection_count")
        parse_info = diagnostics.get("parse") if isinstance(diagnostics.get("parse"), dict) else {}
        filter_info = diagnostics.get("filter") if isinstance(diagnostics.get("filter"), dict) else {}
        drop_reasons = filter_info.get("drop_reasons") if isinstance(filter_info, dict) else {}
        print(
            f"🧪 [VLM-run] query={query!r} raw={raw_count} filtered={filtered_count} "
            f"ranked={len(detections)} drop_reasons={drop_reasons}"
        )
        if parse_info:
            print(f"🧪 [VLM-run] parse={parse_info}")
        if len(detections) == 0:
            preview = diagnostics.get("raw_response_preview")
            if isinstance(preview, str) and preview:
                print(f"🧪 [VLM-run] response_preview={preview[:260]}")
            rejected = filter_info.get("rejected_samples", []) if isinstance(filter_info, dict) else []
            if rejected:
                print(f"🧪 [VLM-run] rejected_samples={rejected}")
    for i, det in enumerate(detections[:5]):
        print(
            f"🧪 [VLM-run] kept[{i}] label={det.get('label')} conf={det.get('confidence')} "
            f"bbox_abs={det.get('bbox_absolute')} source_query={det.get('source_query')}"
        )
    return {
        "query": query,
        "detections": detections,
        "latency_ms": int(result.get("model_latency_ms", 0) or 0),
        "diagnostics": diagnostics,
    }


def _merge_vlm_runs(runs: List[Dict[str, Any]], query: str) -> Tuple[List[Dict[str, Any]], int]:
    dedup: Dict[str, Dict[str, Any]] = {}
    total_latency = 0
    for run in runs:
        total_latency += int(run.get("latency_ms", 0) or 0)
        run_query = str(run.get("query", "")).strip()
        for det in run.get("detections", []) or []:
            box = _safe_box_from_detection(det)
            if not box:
                continue
            key = (
                f"{str(det.get('label', '')).strip().lower()}|"
                f"{int(box['x']//12)}|{int(box['y']//12)}|{int(box['width']//12)}|{int(box['height']//12)}"
            )
            candidate = dict(det)
            candidate["source_query"] = run_query
            conf = float(candidate.get("confidence", 0.0) or 0.0)
            existing = dedup.get(key)
            if not existing or conf > float(existing.get("confidence", 0.0) or 0.0):
                dedup[key] = candidate
    merged = _rank_vlm_detections(list(dedup.values()), query)
    return merged, total_latency


def _vlm_context_json_block(
    endpoint_label: str,
    query: str,
    detections: List[Dict[str, Any]],
    mapped: List[Dict[str, Any]],
    total_latency_ms: int,
    used_queries: Optional[List[str]] = None,
    diagnostics: Optional[List[Dict[str, Any]]] = None,
) -> str:
    compact_detections = []
    for det in detections[:5]:
        compact_detections.append({
            "label": det.get("label"),
            "confidence": det.get("confidence"),
            "bbox_absolute": det.get("bbox_absolute"),
            "source_query": det.get("source_query"),
        })

    compact_mapped = []
    for item in mapped[:5]:
        compact_mapped.append({
            "vlm_label": item.get("det_label"),
            "elementIndex": item.get("dom_index"),
            "dom_label": item.get("dom_label"),
            "dom_bbox_source": item.get("dom_bbox_source"),
            "score": item.get("score"),
            "iou": item.get("iou"),
            "method": item.get("method"),
        })

    best_conf = float(detections[0].get("confidence", 0.0) or 0.0) if detections else 0.0
    payload = {
        "query": query,
        "usedQueries": used_queries or [query],
        "latencyMs": total_latency_ms,
        "detectionCount": len(detections),
        "bestConfidence": round(best_conf, 4),
        "abstainRecommended": bool(not mapped or best_conf < 0.65),
        "bestElementIndex": mapped[0].get("dom_index") if mapped else None,
        "detections": compact_detections,
        "domSuggestions": compact_mapped,
        "diagnostics": diagnostics or [],
    }
    print(
        f"🤖 [{endpoint_label}] VLM detections={len(detections)} mapped={len(mapped)} "
        f"latency_total={total_latency_ms}ms"
    )
    return (
        "VLM_CONTEXT_JSON:\n"
        + json.dumps(payload, ensure_ascii=True)
        + "\n"
        + "VLM_USAGE_RULES:\n"
        + "- Each detection has bbox_absolute: {x, y, width, height} in pixels (position and size on the screenshot). Use these dimensions to pick the right DOM element when several match by text.\n"
        + "- Use bestElementIndex if it aligns with visible DOM text and control type.\n"
        + "- In your reasoning you MUST: (a) If you used a detection, cite its bbox_absolute numbers (e.g. 'VLM detection at x=420, y=50, width=190, height=16 -> elementIndex 4'). (b) If detections is empty or you did not use VLM, state 'No VLM detections' or 'Chose from DOM only (VLM returned 0 detections)'.\n"
        + "- If abstainRecommended=true or evidence conflicts, ask a short clarification instead of guessing.\n"
    )


def _build_vlm_context_from_screenshot_bytes(
    screenshot_bytes: bytes,
    query: str,
    viewport_info: Optional[str],
    endpoint_label: str,
    dom_text: Optional[str] = None,
    session_id: Optional[str] = None,
) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Run VLM on a screenshot and return (context_str, detections, mapped_indices)."""
    if not screenshot_bytes:
        print(f"🤖 [{endpoint_label}] VLM influence: none (empty screenshot payload).")
        return "", [], []

    if not VLM_AVAILABLE:
        print(f"🤖 [{endpoint_label}] VLM influence: none (VLM backend unavailable).")
        return "", [], []

    try:
        image = Image.open(io.BytesIO(screenshot_bytes)).convert("RGB")
        viewport_width, viewport_height = _parse_viewport_dimensions(
            viewport_info,
            image.size[0],
            image.size[1]
        )
        print(
            f"🤖 [{endpoint_label}] Pipeline: screenshot -> VLM -> Cerebras "
            f"| query='{query}' viewport={viewport_width}x{viewport_height} image={image.size[0]}x{image.size[1]}"
        )

        run = _run_vlm_detection_for_query(
            image=image,
            query=query,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
            session_id=session_id,
        )
        detections = run["detections"]
        mapped = _map_vlm_detections_to_dom_indices(detections, dom_text, query)
        for i, item in enumerate(mapped[:5]):
            print(
                f"🧪 [{endpoint_label}] map[{i}] det={item.get('det_label')} -> "
                f"dom_index={item.get('dom_index')} dom_label={item.get('dom_label')} "
                f"score={item.get('score')} iou={item.get('iou')} method={item.get('method')}"
            )
        context_str = _vlm_context_json_block(
            endpoint_label=endpoint_label,
            query=query,
            detections=detections,
            mapped=mapped,
            total_latency_ms=int(run.get("latency_ms", 0) or 0),
            diagnostics=[run.get("diagnostics", {}) or {}],
        )
        return context_str, detections, mapped
    except Exception as vlm_error:
        print(f"⚠️ [{endpoint_label}] VLM assist failed: {vlm_error}")
        err_str = (
            "VLM_CONTEXT_JSON:\n"
            + json.dumps(
                {"query": query, "error": str(vlm_error), "abstainRecommended": True},
                ensure_ascii=True,
            )
        )
        return err_str, [], []


def _build_vlm_context_from_screenshot_bytes_multi(
    screenshot_bytes: bytes,
    queries: List[str],
    viewport_info: Optional[str],
    endpoint_label: str,
    dom_text: Optional[str] = None,
    session_id: Optional[str] = None,
) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not screenshot_bytes or not queries:
        return "", [], []
    if not VLM_AVAILABLE:
        return "", [], []

    try:
        image = Image.open(io.BytesIO(screenshot_bytes)).convert("RGB")
        viewport_width, viewport_height = _parse_viewport_dimensions(
            viewport_info,
            image.size[0],
            image.size[1]
        )
        unique_queries = []
        for q in queries:
            cleaned = str(q or "").strip()
            if cleaned and cleaned not in unique_queries:
                unique_queries.append(cleaned)
        if not unique_queries:
            return "", [], []

        runs: List[Dict[str, Any]] = []
        for q in unique_queries[:2]:
            print(f"🤖 [{endpoint_label}] VLM focused query: {q}")
            runs.append(
                _run_vlm_detection_for_query(
                    image,
                    q,
                    viewport_width,
                    viewport_height,
                    session_id=session_id,
                )
            )

        primary_query = unique_queries[0]
        detections, total_latency = _merge_vlm_runs(runs, primary_query)
        mapped = _map_vlm_detections_to_dom_indices(detections, dom_text, primary_query)
        for i, item in enumerate(mapped[:5]):
            print(
                f"🧪 [{endpoint_label}] map[{i}] det={item.get('det_label')} -> "
                f"dom_index={item.get('dom_index')} dom_label={item.get('dom_label')} "
                f"score={item.get('score')} iou={item.get('iou')} method={item.get('method')}"
            )
        run_diags = [r.get("diagnostics", {}) or {} for r in runs]
        context_str = _vlm_context_json_block(
            endpoint_label=endpoint_label,
            query=primary_query,
            detections=detections,
            mapped=mapped,
            total_latency_ms=total_latency,
            used_queries=unique_queries[:2],
            diagnostics=run_diags,
        )
        return context_str, detections, mapped
    except Exception as vlm_error:
        print(f"⚠️ [{endpoint_label}] Multi-query VLM assist failed: {vlm_error}")
        err_str = (
            "VLM_CONTEXT_JSON:\n"
            + json.dumps(
                {"queries": queries[:2], "error": str(vlm_error), "abstainRecommended": True},
                ensure_ascii=True,
            )
        )
        return err_str, [], []

cleanup_task_handle: Optional[asyncio.Task] = None


def _select_fallback_element(
    dom: str,
    user_query: str,
    vlm_mapped: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """
    Select a fallback element when AI returns no highlights.
    Intelligently picks the most relevant visible element from DOM.
    """
    if not dom:
        return None

    # Parse DOM to find visible elements
    visible_elements = []
    for line in dom.splitlines():
        line = line.strip()
        if not line:
            continue

        # Extract element index and check if visible
        if line.startswith('[') and ']' in line and '[VISIBLE]' in line:
            try:
                # Extract index: [123] tagName "text" ...
                idx_end = line.index(']')
                element_index = int(line[1:idx_end])

                # Extract tag and text
                parts = line[idx_end+1:].strip().split('"', 2)
                tag = parts[0].strip() if parts else ''
                text = parts[1] if len(parts) > 1 else ''

                visible_elements.append({
                    'index': element_index,
                    'tag': tag,
                    'text': text,
                    'line': line
                })
            except (ValueError, IndexError):
                continue

    if not visible_elements:
        return None

    # Score elements based on relevance to query
    query_lower = user_query.lower()
    query_words = set(query_lower.split())

    scored_elements = []
    for elem in visible_elements:
        score = 0
        text_lower = elem['text'].lower()
        tag = elem['tag'].lower()

        # Boost interactive elements
        if tag in ['button', 'a', 'input']:
            score += 10

        # Boost if text matches query words
        elem_words = set(text_lower.split())
        common_words = query_words & elem_words
        score += len(common_words) * 5

        # Boost if query is substring of text
        if query_lower in text_lower:
            score += 15

        # Boost if text is substring of query (exact match)
        if text_lower and text_lower in query_lower:
            score += 20

        # Penalize very long or very short text
        if len(elem['text']) < 3:
            score -= 5
        if len(elem['text']) > 100:
            score -= 3

        # Boost primary actions
        action_words = ['buy', 'add', 'cart', 'shop', 'purchase', 'get', 'start', 'sign', 'login']
        if any(word in text_lower for word in action_words):
            score += 8

        scored_elements.append((score, elem))

    if not scored_elements:
        return None

    # Sort by score descending
    scored_elements.sort(key=lambda x: x[0], reverse=True)

    # Pick best element
    best_score, best_elem = scored_elements[0]

    # If score is too low, don't return anything
    if best_score < 5:
        return None

    return {
        'elementIndex': best_elem['index'],
        'explanation': f"Best match: {best_elem['text'][:50]}",
        'selectionReason': f"Fallback: Selected most relevant visible element (score: {best_score}). Text: '{best_elem['text'][:50]}'"
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run periodic session cleanup in app lifespan (replaces deprecated startup event)."""
    global cleanup_task_handle

    async def cleanup_task():
        while True:
            await asyncio.sleep(300)  # Every 5 minutes
            session_manager.cleanup_expired_sessions()

    cleanup_task_handle = asyncio.create_task(cleanup_task())
    try:
        yield
    finally:
        if cleanup_task_handle:
            cleanup_task_handle.cancel()
            try:
                await cleanup_task_handle
            except asyncio.CancelledError:
                pass


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session Manager for conversation tracking
session_manager = SessionManager()

@app.get("/health-check")
async def health_check():
    """
    Diagnostic endpoint to check Cerebras API connectivity.
    Useful for debugging network issues before attempting requests.
    """
    network_info = check_network_connectivity()

    return {
        "backend": "ok",
        "api_key_configured": bool(api_key),
        "network": network_info,
        "message": (
            "✓ Ready to connect to Cerebras" if (network_info["dns_ok"] and network_info["https_ok"])
            else "✗ Cannot reach Cerebras API - check network settings"
        )
    }

class Highlight(BaseModel):
    selector: str = ""
    explanation: str
    elementIndex: Optional[int] = None
    selectionReason: Optional[str] = None

class AutomationAction(BaseModel):
    type: str  # "navigate", "click"
    url: Optional[str] = None
    selector: Optional[str] = None

class ChatResponse(BaseModel):
    text: str
    highlights: List[Highlight]
    automation: Optional[AutomationAction] = None
    sessionId: Optional[str] = None  # Session tracking
    reasoning: Optional[str] = None  # AI's thought process for debugging
    tutorialPlan: Optional[dict] = None  # High-level plan for multi-page tutorials


class NextStep(BaseModel):
    instruction: str
    actionType: str = "click"
    isTerminal: bool = False


class NextStepResponse(BaseModel):
    text: str
    step: Optional[NextStep] = None
    highlights: List[Highlight]
    sessionId: Optional[str] = None
    reasoning: Optional[str] = None
    done: bool = False

@app.post("/chat", response_model=ChatResponse)
async def chat(
    message: str = Form(...),
    screenshot: Optional[UploadFile] = File(None),
    sessionId: Optional[str] = Form(None),
    dom: Optional[str] = Form(None),
    completionHistory: Optional[str] = Form(None),
    tutorialContext: Optional[str] = Form(None),
    viewportInfo: Optional[str] = Form(None),
    scrollPosition: Optional[str] = Form(None)
):
    request_started = perf_counter()
    phase_timings_ms: Dict[str, int] = {}
    print(f"📥 [/chat] Received message: {message}")

    # Get or create session
    session = session_manager.get_or_create_session(sessionId)
    if VLM_AVAILABLE:
        ensure_vlm_debug_dir(session.id)
    print(f"🧷 [/chat] Session ID: {session.id}")
    print(f"🧭 [/chat] URL context provided via tutorialContext? {'yes' if tutorialContext else 'no'}")
    print(f"🧠 [/chat] DOM attached? {'yes' if dom else 'no'} | viewportInfo? {'yes' if viewportInfo else 'no'}")
    if dom:
        dom_line_count = len([line for line in dom.splitlines() if line.strip()])
        print(f"📤 [/chat] DOM forwarded for analysis: {dom_line_count} indexed lines")

    if not api_key:
         return ChatResponse(
             text="Please set your CEREBRAS_API_KEY in the backend/.env file to enable the AI agent.",
             highlights=[],
             automation=None,
             sessionId=session.id
         )

    try:
        phase_parse_started = perf_counter()
        tutorial_context_obj: Dict[str, Any] = {}
        if tutorialContext:
            try:
                parsed_tc = json.loads(tutorialContext) if isinstance(tutorialContext, str) else tutorialContext
                if isinstance(parsed_tc, dict):
                    tutorial_context_obj = parsed_tc
            except (json.JSONDecodeError, TypeError):
                tutorial_context_obj = {}

        normalized_message = message.lower().strip()
        is_active_recalc_request = bool(tutorial_context_obj) and (
            "continue the active tutorial" in normalized_message
            or bool(tutorial_context_obj.get("recalculationReason"))
        )
        phase_timings_ms["context_parse"] = int((perf_counter() - phase_parse_started) * 1000)

        vlm_context = ""
        vlm_detections: List[Dict[str, Any]] = []
        vlm_mapped: List[Dict[str, Any]] = []
        if screenshot:
            print(f"🖼️ [/chat] Screenshot received ({screenshot.filename}); preparing VLM assist.")
            screenshot_read_started = perf_counter()
            screenshot_bytes = await screenshot.read()
            phase_timings_ms["screenshot_read"] = int((perf_counter() - screenshot_read_started) * 1000)

            # Build step-specific VLM query when in tutorial mode
            vlm_query = message
            if tutorial_context_obj:
                current_step_text = str(tutorial_context_obj.get("currentStep", "")).strip()
                current_action_type = str(tutorial_context_obj.get("currentActionType", "")).strip().lower()
                if current_step_text:
                    if current_action_type == "input":
                        expected_control = "input"
                    elif current_action_type in {"navigate"}:
                        expected_control = "link"
                    elif current_action_type in {"click"}:
                        expected_control = "button"
                    else:
                        expected_control = _infer_expected_control_from_instruction(current_step_text)
                    step_literal = json.dumps(current_step_text, ensure_ascii=True)
                    vlm_query = f"action={current_action_type or 'click'}; expected_control={expected_control}; target_instruction={step_literal}"
                    print(f"🤖 [/chat] Using step-specific VLM query: {vlm_query}")

            vlm_started = perf_counter()
            vlm_context, vlm_detections, vlm_mapped = _build_vlm_context_from_screenshot_bytes(
                screenshot_bytes=screenshot_bytes,
                query=vlm_query,
                viewport_info=viewportInfo,
                endpoint_label="/chat",
                dom_text=dom,
                session_id=session.id,
            )
            phase_timings_ms["vlm_pipeline"] = int((perf_counter() - vlm_started) * 1000)
        else:
            print("🖼️ [/chat] No screenshot provided.")
            print("🤖 [/chat] VLM influence: none (no screenshot in /chat request).")

        # Store user message in session
        session.add_message('user', message)

        # ====================================================================
        # PROMPT CONSTRUCTION - MODULAR APPROACH
        # ====================================================================

        # Detect request type
        is_selection_request = any(keyword in normalized_message for keyword in [
            'select', 'highlight', 'show me', 'point to', 'find', 'where is',
            'click on', 'identify', 'mark', 'circle'
        ])

        is_multiple_elements = any(keyword in normalized_message for keyword in [
            'all', 'every', 'each'
        ])

        tutorial_intent_patterns = [
            "tutorial", "step by step", "step-by-step", "walk me through",
            "guide me", "show me how", "teach me how", "how to ", "how do i ",
            "help me do", "what should i click",
        ]
        is_tutorial_request = bool(tutorialContext) or any(
            pattern in normalized_message for pattern in tutorial_intent_patterns
        )

        # ====================================================================
        # BUILD CENTRAL PROMPT - MODULAR SECTIONS
        # ====================================================================

        prompt_sections = []

        # Section 1: System Role & User Question
        prompt_sections.append(f"""You are a Site Tutor, an expert web developer and UI guide.
Your goal is to answer the user's question and identify specific HTML elements to highlight.

User Question: "{message}"
""")

        # Section 2: Mode Instructions (Tutorial vs. Normal)
        if is_tutorial_request:
            prompt_sections.append("""
══════════════════════════════════════════════════════════════
                    TUTORIAL MODE - ACTIVE
══════════════════════════════════════════════════════════════

CORE TASK: Create a complete multi-step tutorial

You must generate a TWO-TIER response:
1. A HIGH-LEVEL PLAN of ALL steps needed to complete the task (across ALL pages)
2. CURRENT-PAGE HIGHLIGHTS only for steps that can be performed on THIS page (visible in the screenshot/DOM)

REQUIREMENTS:
1. Create a complete plan with ALL steps numbered globally (1, 2, 3, ..., N)
2. For each step, indicate if it will cause a PAGE CHANGE (navigation to a different URL)
3. Identify which steps can be done on the CURRENT page shown in the screenshot
4. ALWAYS return at least one highlight for visible elements - never return empty highlights
5. Return steps in the "text" field as numbered lines (ALL steps, not just current page)
6. NEVER use vague steps like "browse models", "look through options", or "explore". Every step must tell exactly what to click/type using concrete visible labels from the indexed DOM.
7. If user intent is broad (e.g., "buy iPhone"), choose a concrete default from visible DOM options:
   - prefer exact topic label first (e.g., "iPhone")
   - otherwise choose the latest visible numbered model (e.g., "iPhone 17")
   - otherwise choose the first visible relevant option
8. For phone purchase intents (buy/purchase/order a phone): include a step that explicitly clicks the visible "Buy" control for the selected phone model, then end the tutorial once the buy portal/configurator page is open. Do NOT continue into checkout, payment, shipping, or order submission.

ELEMENT SELECTION RULES (CRITICAL - follow strictly):
1. SPECIFICITY FIRST: Choose the element whose visible text MOST PRECISELY matches the target, with the FEWEST extra words.
   - Query "iPhone" → element "iPhone" (NOT "iPhone Pro" or "iPhone Pro Max")
   - Query "iPhone Pro" → element "iPhone Pro" (NOT "iPhone" or "iPhone Pro Max")
   - Query "Add to Cart" → element "Add to Cart" (NOT "Add to Cart and Continue Shopping")
   - The BEST match is the one where the element text is closest in length and content to the query.
2. EXACT > NEAR-EXACT > PARTIAL: Prefer exact text matches over partial ones. If no exact match, prefer the element with the LEAST surplus text beyond the query words.
3. VISIBLE PREFERENCE: Among equally specific matches, prefer [VISIBLE] elements.
4. ALWAYS GUESS: If no good match exists, still return your best guess from available elements - never return empty highlights.
5. CUSTOMER POV: Prefer the primary in-page control a normal customer is intended to click next.
6. AVOID STICKY DUPLICATES: De-prioritize sticky/fixed/global navigation bars (including top bars that appear after scrolling past hero sections) unless the user explicitly asks for nav/header/menu controls or no better in-page control exists.

GOOD RESPONSE EXAMPLE:
{{
  "text": "1. Click the New button\\n2. Enter repository name",
  "highlights": [{{"elementIndex": 5, "explanation": "Click the New button"}}],
  "reasoning": "Found button with matching text at index 5"
}}

BAD RESPONSE EXAMPLE (DO NOT DO THIS):
{{
  "text": "I cannot determine which element to highlight...",
  "highlights": [],
  "reasoning": "Unable to find exact match"
}}

Include a "tutorialPlan" object in your response:
{{
  "text": "1. Click the New button\\n2. Enter repository name\\n3. Choose visibility\\n4. Click Create",
  "tutorialPlan": {{
    "title": "Tutorial title here",
    "totalSteps": 4,
    "planSteps": [
      {{"stepNumber": 1, "instruction": "Click the New button", "actionType": "click", "expectsPageChange": true, "pageDescription": "GitHub main page", "isTerminal": false}},
      {{"stepNumber": 2, "instruction": "Enter repository name", "actionType": "input", "expectsPageChange": false, "pageDescription": "Repository creation form", "isTerminal": false}},
      {{"stepNumber": 3, "instruction": "Choose visibility", "actionType": "click", "expectsPageChange": false, "pageDescription": "Repository creation form", "isTerminal": false}},
      {{"stepNumber": 4, "instruction": "Click Create repository", "actionType": "click", "expectsPageChange": true, "pageDescription": "Repository creation form", "isTerminal": true}}
    ],
    "currentPageHighlights": [
      {{"elementIndex": 5, "explanation": "Click the New button"}}
    ],
    "currentPageRange": {{"startIndex": 0, "endIndex": 0}}
  }},
  "highlights": [
    {{"elementIndex": 5, "explanation": "Click the New button"}}
  ],
  "reasoning": "Found button at index 5, it matches the first step instruction"
}}

CRITICAL RULES:
- "planSteps" must include ALL steps for the ENTIRE task, even those on future pages
- "currentPageHighlights" MUST include at least one element when visible elements exist
- "highlights" should match "currentPageHighlights" (for backward compatibility)
- Only include [VISIBLE] marked elements in highlights - NEVER include [BELOW-SCROLL] elements
- "expectsPageChange" should be true if clicking/completing that step will navigate to a new URL
- "actionType" must be one of: "click", "input", "navigate", "wait", "observe"
- Use "observe" for steps where the user should read/wait without clicking anything (e.g., "Wait for the page to load", "Read the confirmation message"). Observe steps should have elementIndex: null.
- Include exactly one terminal step: set "isTerminal": true only on the final step.
- For phone purchase intents, the final step must be "buy portal is open" (observe/wait), not checkout/payment.
- Use the indexed element list to find EXACT element indices for current-page steps only
- If no exact match exists, make your best guess from available [VISIBLE] elements
- Match control type to instruction:
  - "type/enter/fill" -> select an input/textarea/select field, not a container
  - "click/buy/continue/submit" -> select a button-like or clickable control
  - "open/go to/navigate" -> select a link-like control
- Never target generic containers (`div`, `section`, `ul`, `li`, `main`, `article`) when a clickable/input control exists.
""")
        else:
            prompt_sections.append("""
NORMAL MODE: Answer conversationally.
- Do NOT force a numbered tutorial
- Answer directly and helpfully
- Return highlights only if useful for the question
""")

        # Section 3: Request-Specific Instructions
        if is_selection_request:
            prompt_sections.append("""
⚠️ SELECTION REQUEST: User wants to SELECT/HIGHLIGHT a specific element.
- MUST return at least one highlight with valid elementIndex
- Cross-reference screenshot and indexed DOM
""")

        if is_multiple_elements:
            prompt_sections.append("""
⚠️ MULTIPLE ELEMENTS: Generate SEPARATE highlight for EACH matching element.
""")

        # Section 4: DOM Context (if provided)
        if dom:
            prompt_sections.append(f"""
══════════════════════════════════════════════════════════════
            INDEXED ELEMENTS ON THIS PAGE
══════════════════════════════════════════════════════════════

Format: [index] tagName "text" attributes in-PARENT [POSITION] [VISIBLE|BELOW-SCROLL]

ANNOTATIONS:
- [VISIBLE]: In viewport - PREFER THESE
- [BELOW-SCROLL]: Below fold - don't highlight (add scroll instruction instead)
- [TOP/MID/BOTTOM-SECTION]: Vertical position
- in-TAGNAME: Parent context

{dom}
""")

        # Section 5: VLM Context (if provided)
        if vlm_context:
            prompt_sections.append(f"""
══════════════════════════════════════════════════════════════
              VLM VISUAL DETECTION RESULTS
══════════════════════════════════════════════════════════════

{vlm_context}

🚨 VLM USAGE RULES (MANDATORY):
1. If detections > 0: USE VLM AS PRIMARY SOURCE
2. Use `domSuggestions[].elementIndex` from VLM results
3. Cite bbox_absolute in reasoning: "VLM at x=420, y=50, w=190, h=16 → elementIndex=4"
4. IGNORE extension UI artifacts: "Site Tutor", "Tutorial step", "Verify Step"
5. If bestElementIndex provided: verify DOM text match, then use it

❌ WRONG: "Chose from DOM only" when VLM detections exist
✅ CORRECT: "VLM bbox x=420, y=50 → elementIndex=4"

If no VLM OR all are UI artifacts: state "No usable VLM", fall back to DOM matching
""")

        # Section 6: Viewport Info (if provided)
        if viewportInfo:
            prompt_sections.append(f"""
══════════════════════════════════════════════════════════════
                   VIEWPORT INFORMATION
══════════════════════════════════════════════════════════════

{viewportInfo}

VIEWPORT RULES:
- ONLY highlight [VISIBLE] elements
- NEVER highlight [BELOW-SCROLL] (add scroll instruction if needed)
""")

        # Section 7: User History (if provided)
        if completionHistory:
            prompt_sections.append(f"""
══════════════════════════════════════════════════════════════
                PRIOR LEARNING HISTORY
══════════════════════════════════════════════════════════════

{completionHistory}

→ Skip basics user already knows
→ Build on prior knowledge
""")

        # Section 8: Current Tutorial State (if provided)
        if tutorialContext:
            prompt_sections.append(f"""
══════════════════════════════════════════════════════════════
              CURRENT TUTORIAL CONTEXT
══════════════════════════════════════════════════════════════

{tutorialContext}

→ User is mid-tutorial - continue from current step
→ Reference next best action if user asks questions
""")

        # Section 9: Selection Priority Rules (Universal)
        prompt_sections.append("""
══════════════════════════════════════════════════════════════
            ELEMENT SELECTION PRIORITY
══════════════════════════════════════════════════════════════

🎯 PRIORITY ORDER (Most → Least Important):
1. SPECIFICITY: Exact text match with fewest extra words
   • "iPhone" → [5] "iPhone" NOT [6] "iPhone Pro"
   • "Add to Bag" → [10] "Add to Bag" NOT [11] "Add to Bag - Express"
2. CONTENT > NAVIGATION: Main content over header/footer/sidebar
3. SPECIFIC > GENERIC: "iPhone 17" > "All iPhones" > "Shop iPhone"
4. VISIBLE ONLY: [VISIBLE] over [BELOW-SCROLL]
5. PRIMARY ACTIONS: Main CTA buttons over secondary actions

⚠️ AVOID (unless requested):
- Nav menus when main content has same link
- Generic "Browse"/"Explore" when specific items visible
- Containers (<div>, <section>) when controls (<button>, <a>) exist

✅ SPECIFICITY EXAMPLES:
[5] "iPhone" [6] "iPhone Pro" [7] "iPhone Pro Max"
  • Query "iPhone" → elementIndex: 5 (exact)
  • Query "iPhone Pro" → elementIndex: 6 (exact)
""")

        # Section 10: Automation Capability
        prompt_sections.append("""
══════════════════════════════════════════════════════════════
                AUTOMATION CAPABILITY
══════════════════════════════════════════════════════════════

When user wants you to take over:
  Triggers: "I give up", "Just do it", "You do it", "Can you do it"

Actions:
  • Navigate: {"type": "navigate", "url": "..."}
  • Click: {"type": "click", "elementIndex": X}

ONLY automate when user CLEARLY requests it.
""")

        # Section 11: Response Format
        prompt_sections.append("""
══════════════════════════════════════════════════════════════
                   RESPONSE FORMAT
══════════════════════════════════════════════════════════════

STANDARD:
{
  "text": "Answer or numbered steps",
  "highlights": [{"elementIndex": 5, "explanation": "Label"}],
  "automation": null,
  "reasoning": "REQUIRED: Cite VLM bbox if used, else 'No VLM'. Explain element selection."
}

AUTOMATION:
{
  "text": "Confirmation",
  "highlights": [],
  "automation": {"type": "navigate|click", ...},
  "reasoning": "Why automation is appropriate"
}

🚨 CRITICAL REQUIREMENTS:
1. ALWAYS include "reasoning" field (for debugging)
2. ALWAYS return at least ONE highlight when visible elements exist
   - If uncertain, pick your BEST GUESS from [VISIBLE] elements
   - NEVER return empty highlights array: []
   - NEVER say "I cannot determine which element"
3. Tutorial responses MUST include "tutorialPlan" object
4. In highlights, set "explanation" to tell user what they should click/select

❌ NEVER DO THIS:
{
  "text": "I cannot find the element",
  "highlights": [],
  "reasoning": "No matching elements found"
}

✅ ALWAYS DO THIS:
{
  "text": "Click on the best matching element I found",
  "highlights": [{"elementIndex": 12, "explanation": "This button seems most relevant"}],
  "reasoning": "No exact match, but element 12 has similar text. Making best guess."
}

**REMEMBER:** Users need to see SOMETHING highlighted. An educated guess is better than nothing!
""")

        # Section 12: Screenshot Note
        if screenshot:
            prompt_sections.append("\n(Screenshot provided but omitted; Cerebras is text-only)")
        else:
            prompt_sections.append("\n(No screenshot; answer from DOM and general knowledge)")

        # Assemble final prompt
        prompt_text = "\n".join(prompt_sections)

        # Call Cerebras API
        cerebras_started = perf_counter()
        response = cerebras_chat(
            [{"role": "user", "content": prompt_text}],
            max_tokens=max_output_tokens,
            temperature=0.0,
            stream=False,
        )
        phase_timings_ms["cerebras_call"] = int((perf_counter() - cerebras_started) * 1000)

        raw_text = extract_cerebras_message(response)
        print(f"Cerebras raw response: {raw_text}")
        
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

        # Normalize common key typos from model output
        tutorial_plan_data = parsed.get("tutorialPlan")
        if not isinstance(tutorial_plan_data, dict):
            for alt_key in ("torialPlan", "tutorial_plan", "tutorialplan"):
                alt_value = parsed.get(alt_key)
                if isinstance(alt_value, dict):
                    tutorial_plan_data = alt_value
                    parsed["tutorialPlan"] = tutorial_plan_data
                    break

        if isinstance(tutorial_plan_data, dict):
            tutorial_plan_data = _de_generic_tutorial_plan(tutorial_plan_data, dom, message)
            tutorial_plan_data = _normalize_tutorial_plan_schema(tutorial_plan_data)
            parsed["tutorialPlan"] = tutorial_plan_data
            # Keep conversational "text" aligned with concrete plan step instructions.
            text_override = tutorial_plan_data.get("textOverride")
            if isinstance(text_override, str) and text_override.strip():
                parsed["text"] = text_override

        if (not isinstance(parsed.get("highlights"), list) or not parsed.get("highlights")) and isinstance(tutorial_plan_data, dict):
            fallback_highlights = tutorial_plan_data.get("currentPageHighlights")
            if isinstance(fallback_highlights, list) and fallback_highlights:
                parsed["highlights"] = fallback_highlights

        # Only run model-specificity refinement when there's no VLM data AND no tutorial plan.
        # Tutorial plans already have specific step instructions; overriding them corrupts the flow.
        has_tutorial_plan = isinstance(tutorial_plan_data, dict) and tutorial_plan_data
        topic_context = f"{message} {tutorialContext or ''}"
        topic = _infer_topic_from_message(topic_context)
        raw_highlights = parsed.get("highlights", [])
        if isinstance(raw_highlights, list) and raw_highlights and not vlm_mapped and not has_tutorial_plan:
            refined_highlights, chosen_label = _refine_highlights_to_specific_model(
                raw_highlights,
                dom,
                topic,
                str(parsed.get("text", ""))
            )
            parsed["highlights"] = refined_highlights
            if chosen_label:
                if isinstance(tutorial_plan_data, dict):
                    cph = tutorial_plan_data.get("currentPageHighlights")
                    if isinstance(cph, list) and len(cph) > 0 and isinstance(cph[0], dict):
                        cph[0]["elementIndex"] = refined_highlights[0].get("elementIndex")
                        cph[0]["explanation"] = refined_highlights[0].get("explanation")

        instruction_hints = _extract_numbered_steps_from_text(str(parsed.get("text", "")))
        raw_highlights = parsed.get("highlights", [])
        if isinstance(raw_highlights, list) and raw_highlights:
            action_hints: List[str] = []
            if isinstance(tutorial_plan_data, dict):
                current_range = tutorial_plan_data.get("currentPageRange", {})
                start_idx = int(current_range.get("startIndex", 0)) if isinstance(current_range, dict) else 0
                plan_steps = tutorial_plan_data.get("planSteps")
                if isinstance(plan_steps, list):
                    for i, _ in enumerate(instruction_hints):
                        plan_i = start_idx + i
                        if plan_i < len(plan_steps) and isinstance(plan_steps[plan_i], dict):
                            action_hints.append(str(plan_steps[plan_i].get("actionType", "")).strip().lower())

            if vlm_mapped:
                vlm_first_highlights, vlm_first_changed = _apply_vlm_first_highlight_selection(
                    raw_highlights,
                    vlm_mapped,
                    dom,
                    instruction_hints,
                    action_hints,
                )
                if vlm_first_changed:
                    print("🎯 [/chat] applied VLM-first highlight selection (heuristic control-refine skipped)")
                    parsed["highlights"] = vlm_first_highlights
                    if isinstance(tutorial_plan_data, dict):
                        cph = tutorial_plan_data.get("currentPageHighlights")
                        if isinstance(cph, list):
                            for i, h in enumerate(vlm_first_highlights):
                                if i < len(cph) and isinstance(cph[i], dict) and isinstance(h, dict):
                                    cph[i]["elementIndex"] = h.get("elementIndex")
                                    cph[i]["explanation"] = h.get("explanation")
                                    cph[i]["selectionReason"] = h.get("selectionReason") or h.get("explanation")
            else:
                control_refined_highlights, control_refined_steps, controls_changed = _refine_highlights_to_control_type(
                    raw_highlights,
                    dom,
                    instruction_hints,
                    action_hints
                )
                if controls_changed:
                    parsed["highlights"] = control_refined_highlights
                    if control_refined_steps:
                        parsed["text"] = _render_numbered_steps(control_refined_steps)
                    if isinstance(tutorial_plan_data, dict):
                        cph = tutorial_plan_data.get("currentPageHighlights")
                        if isinstance(cph, list):
                            for i, h in enumerate(control_refined_highlights):
                                if i < len(cph) and isinstance(cph[i], dict) and isinstance(h, dict):
                                    cph[i]["elementIndex"] = h.get("elementIndex")
                                    cph[i]["explanation"] = h.get("explanation")
                                    cph[i]["selectionReason"] = h.get("explanation")  # Also set selectionReason for frontend

        # Constrain highlights to VLM bounding boxes when VLM data is available
        raw_highlights_pre_vlm = parsed.get("highlights", [])
        if vlm_mapped and isinstance(raw_highlights_pre_vlm, list) and raw_highlights_pre_vlm:
            constrained = _constrain_highlights_to_vlm_bounds(
                raw_highlights_pre_vlm, dom, vlm_detections, vlm_mapped
            )
            parsed["highlights"] = constrained
            # Also update tutorialPlan.currentPageHighlights
            if isinstance(tutorial_plan_data, dict):
                cph = tutorial_plan_data.get("currentPageHighlights")
                if isinstance(cph, list):
                    for i, h in enumerate(constrained):
                        if i < len(cph) and isinstance(cph[i], dict) and isinstance(h, dict):
                            cph[i]["elementIndex"] = h.get("elementIndex")
                            cph[i]["explanation"] = h.get("explanation")
                            cph[i]["selectionReason"] = h.get("explanation")  # Also set selectionReason for frontend

        # Dynamic recalculation should keep the original stored plan, not regenerate one.
        if is_active_recalc_request and session.tutorial_plan:
            plan_state = session.tutorial_plan
            raw_idx = tutorial_context_obj.get("currentGlobalStepIndex")
            if not isinstance(raw_idx, int):
                raw_idx = tutorial_context_obj.get("currentStepIndex")
            try:
                start_idx = int(raw_idx if raw_idx is not None else plan_state.current_page_start_index)
            except (TypeError, ValueError):
                start_idx = int(plan_state.current_page_start_index)
            if start_idx < 0:
                start_idx = 0
            plan_steps = plan_state.plan_steps if isinstance(plan_state.plan_steps, list) else []
            if plan_steps:
                start_idx = min(start_idx, len(plan_steps) - 1)
            current_highlights = parsed.get("highlights", [])
            if not isinstance(current_highlights, list):
                current_highlights = []
            tutorial_plan_data = {
                "title": plan_state.title,
                "totalSteps": plan_state.total_steps,
                "planSteps": plan_steps,
                "currentPageHighlights": current_highlights,
                "currentPageRange": {"startIndex": start_idx, "endIndex": start_idx},
            }
            parsed["tutorialPlan"] = tutorial_plan_data

        parsed["highlights"] = _annotate_highlights_with_vlm_trace(
            parsed.get("highlights", []),
            vlm_mapped,
            vlm_detections,
            screenshot_provided=bool(screenshot),
            vlm_context=vlm_context,
        )
        # CRITICAL: Ensure selectionReason is ALWAYS set for regular highlights
        for i, h in enumerate(parsed.get("highlights", [])):
            if isinstance(h, dict):
                if not h.get("selectionReason"):
                    fallback_reason = h.get("explanation", "Element selected for this step")
                    h["selectionReason"] = fallback_reason
                    print(f"⚠️ [/chat] Highlight {i} missing selectionReason, using fallback: {fallback_reason[:50]}")
                if not h.get("explanation"):
                    h["explanation"] = h.get("selectionReason", "Selected element")

        if isinstance(tutorial_plan_data, dict):
            cph = tutorial_plan_data.get("currentPageHighlights")
            if isinstance(cph, list):
                tutorial_plan_data["currentPageHighlights"] = _annotate_highlights_with_vlm_trace(
                    cph,
                    vlm_mapped,
                    vlm_detections,
                    screenshot_provided=bool(screenshot),
                    vlm_context=vlm_context,
                )
                # Ensure selectionReason is always set for frontend
                for h in tutorial_plan_data["currentPageHighlights"]:
                    if isinstance(h, dict):
                        if not h.get("selectionReason"):
                            h["selectionReason"] = h.get("explanation", "Element selected for this step")
                        if not h.get("explanation"):
                            h["explanation"] = h.get("selectionReason", "Selected element")

        bot_response_text = parsed.get("text", "I analyzed the page but couldn't formulate a response.")
        reasoning = parsed.get("reasoning", "")

        # DEBUG: Log reasoning and highlights
        highlights = parsed.get("highlights", [])
        print(f"\n=== AI REASONING DEBUG ===")
        if reasoning:
            print(f"AI Thought Process:\n{reasoning}\n")
        step_lines = [line for line in bot_response_text.splitlines() if line.strip() and line[0].isdigit()]
        print(f"Total steps in text: {len(step_lines)}")
        print(f"Total highlights returned: {len(highlights)}")
        if highlights:
            for i, h in enumerate(highlights):
                reason = h.get('selectionReason', h.get('explanation', 'none'))
                vlm_used = 'VLM' in reason
                print(f"  Step {i+1} → elementIndex={h.get('elementIndex', 'none')}, VLM={'✓' if vlm_used else '✗'}, reason=\"{reason[:100]}...\"")

        # Also log tutorial plan highlights if present
        if isinstance(tutorial_plan_data, dict):
            cph = tutorial_plan_data.get("currentPageHighlights", [])
            if cph:
                print(f"\nTutorial Plan Highlights: {len(cph)}")
                for i, h in enumerate(cph):
                    if isinstance(h, dict):
                        reason = h.get('selectionReason', h.get('explanation', 'none'))
                        vlm_used = 'VLM' in reason
                        print(f"  Plan Step {i+1} → elementIndex={h.get('elementIndex', 'none')}, VLM={'✓' if vlm_used else '✗'}, reason=\"{reason[:100]}...\"")
        print("========================\n")

        # Store bot message in session
        session.add_message('bot', bot_response_text)

        # Store tutorial plan in session if present
        if tutorial_plan_data and isinstance(tutorial_plan_data, dict):
            prior_completed = []
            if session.tutorial_plan and isinstance(session.tutorial_plan.completed_step_indices, list):
                prior_completed = list(session.tutorial_plan.completed_step_indices)
            plan_steps = tutorial_plan_data.get("planSteps", [])
            session.tutorial_plan = TutorialPlanState(
                plan_steps=plan_steps,
                completed_step_indices=prior_completed,
                current_page_start_index=tutorial_plan_data.get("currentPageRange", {}).get("startIndex", 0),
                original_query=(session.tutorial_plan.original_query if (session.tutorial_plan and is_active_recalc_request) else message),
                title=tutorial_plan_data.get("title", session.tutorial_plan.title if session.tutorial_plan else "Tutorial"),
                total_steps=tutorial_plan_data.get("totalSteps", len(plan_steps)),
            )
            print(f"\n=== TUTORIAL PLAN STORED ===")
            print(f"Title: {session.tutorial_plan.title}")
            print(f"Total steps: {session.tutorial_plan.total_steps}")
            current_range = tutorial_plan_data.get("currentPageRange", {})
            print(f"Current page range: {current_range.get('startIndex', 0)}-{current_range.get('endIndex', 0)}")
            print("===========================\n")

        # Parse automation if present
        automation_data = parsed.get("automation")
        automation = None

        if automation_data and isinstance(automation_data, dict):
            automation = AutomationAction(**automation_data)

        # ====================================================================
        # CRITICAL VALIDATION: NEVER RETURN EMPTY HIGHLIGHTS
        # ====================================================================
        # If AI returned no highlights but DOM has visible elements, pick the best one
        final_highlights = parsed.get("highlights", [])

        if not final_highlights or not isinstance(final_highlights, list) or len(final_highlights) == 0:
            print("⚠️ [/chat] AI returned empty highlights - applying fallback selection")

            # Try to find a relevant element from DOM
            if dom:
                fallback_highlight = _select_fallback_element(dom, message, vlm_mapped)
                if fallback_highlight:
                    final_highlights = [fallback_highlight]
                    bot_response_text = f"{bot_response_text}\n\n💡 I've highlighted the most relevant element I could find on this page."
                    print(f"✅ [/chat] Fallback selection applied: elementIndex={fallback_highlight.get('elementIndex')}")
                else:
                    print("⚠️ [/chat] No suitable fallback element found in DOM")

        # Double-check: if still empty in tutorial mode, that's an error
        if is_tutorial_request and (not final_highlights or len(final_highlights) == 0):
            print("🚨 [/chat] CRITICAL: Tutorial mode with no highlights - this should never happen!")
            # Add warning to response text
            bot_response_text = f"{bot_response_text}\n\n⚠️ I couldn't identify a specific element to highlight. Please try rephrasing your request or refresh the page."

        phase_timings_ms["total_request"] = int((perf_counter() - request_started) * 1000)
        print(f"⏱️ [/chat] timings_ms={phase_timings_ms}")

        return ChatResponse(
            text=bot_response_text,
            highlights=final_highlights,
            automation=automation,
            sessionId=session.id,
            reasoning=reasoning,
            tutorialPlan=tutorial_plan_data
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
        print(f"Error calling Cerebras: {e}")
        phase_timings_ms["total_request"] = int((perf_counter() - request_started) * 1000)
        print(f"⏱️ [/chat] timings_ms={phase_timings_ms}")
        return ChatResponse(
            text=f"I encountered an error analyzing the page: {str(e)}",
            highlights=[],
            automation=None,
            sessionId=session.id
        )


@app.post("/next-step", response_model=NextStepResponse)
@app.post("/next-step/", response_model=NextStepResponse, include_in_schema=False)
async def next_step(
    goal: str = Form(...),
    screenshot: Optional[UploadFile] = File(None),
    sessionId: Optional[str] = Form(None),
    dom: Optional[str] = Form(None),
    viewportInfo: Optional[str] = Form(None),
    currentUrl: Optional[str] = Form(None),
    completedStepInstruction: Optional[str] = Form(None),
    tutorialContext: Optional[str] = Form(None),
):
    """
    Return exactly one adaptive next step for the user's current screen.
    This endpoint is designed for screen-by-screen tutorials and should not
    return full multi-page plans.
    """
    request_started = perf_counter()
    phase_timings_ms: Dict[str, int] = {}
    cleaned_goal = str(goal or "").strip()
    session = session_manager.get_or_create_session(sessionId)
    if VLM_AVAILABLE:
        ensure_vlm_debug_dir(session.id)

    print(f"📥 [/next-step] goal={cleaned_goal}")
    print(f"🧷 [/next-step] Session ID: {session.id}")
    print(f"🧠 [/next-step] DOM attached? {'yes' if dom else 'no'} | viewportInfo? {'yes' if viewportInfo else 'no'}")

    if not cleaned_goal:
        return NextStepResponse(
            text="Please share what you want to do on this page.",
            highlights=[],
            sessionId=session.id,
            done=False,
        )

    if not api_key:
        return NextStepResponse(
            text="Please set your CEREBRAS_API_KEY in backend/.env.",
            highlights=[],
            sessionId=session.id,
            done=False,
        )

    try:
        tutorial_context_obj: Dict[str, Any] = {}
        if tutorialContext:
            try:
                parsed_tc = json.loads(tutorialContext) if isinstance(tutorialContext, str) else tutorialContext
                if isinstance(parsed_tc, dict):
                    tutorial_context_obj = parsed_tc
            except (json.JSONDecodeError, TypeError):
                tutorial_context_obj = {}

        vlm_context = ""
        vlm_detections: List[Dict[str, Any]] = []
        vlm_mapped: List[Dict[str, Any]] = []
        if screenshot:
            screenshot_read_started = perf_counter()
            screenshot_bytes = await screenshot.read()
            phase_timings_ms["screenshot_read"] = int((perf_counter() - screenshot_read_started) * 1000)
            vlm_query = cleaned_goal
            if completedStepInstruction:
                vlm_query = (
                    f'goal="{cleaned_goal}"; previous_step="{completedStepInstruction}"; '
                    f'current_url="{currentUrl or ""}"'
                )
            vlm_started = perf_counter()
            vlm_context, vlm_detections, vlm_mapped = _build_vlm_context_from_screenshot_bytes(
                screenshot_bytes=screenshot_bytes,
                query=vlm_query,
                viewport_info=viewportInfo,
                endpoint_label="/next-step",
                dom_text=dom,
                session_id=session.id,
            )
            phase_timings_ms["vlm_pipeline"] = int((perf_counter() - vlm_started) * 1000)
        else:
            print("🖼️ [/next-step] No screenshot provided.")

        dom_context = ""
        if dom:
            dom_context = f"""
INDEXED ELEMENTS ON THIS PAGE:
{dom}
"""

        viewport_context = ""
        if viewportInfo:
            viewport_context = f"""
VIEWPORT INFORMATION:
{viewportInfo}
"""

        progress_context = ""
        if completedStepInstruction:
            progress_context += f'Previous verified step: "{completedStepInstruction}"\n'
        if currentUrl:
            progress_context += f"Current URL: {currentUrl}\n"

        prompt_text = f"""
You are an adaptive UI tutorial agent.
Goal: "{cleaned_goal}"

{progress_context}
{dom_context}
{vlm_context}
{viewport_context}

Return EXACTLY ONE actionable next step for the CURRENT screen.
Do NOT return a 10-step plan or any multi-step list.
Do NOT include future-page subtasks.

Rules:
1. Give one immediate step only.
2. If the current screen already indicates the previous navigation succeeded, continue from this screen.
3. Prefer a [VISIBLE] interactive element from indexed DOM.
4. Use VLM mapped elementIndex when available and relevant.
5. For "observe"/"wait" steps, highlights may be empty.
6. If the goal is to buy/purchase/order a phone, the next action should be clicking the visible "Buy" control for the chosen model; once the buy portal/configurator is open, return a terminal observe/wait step and stop (no checkout/payment steps).

Respond ONLY as JSON with this exact shape:
{{
  "text": "short instruction for the user",
  "step": {{
    "instruction": "single next action",
    "actionType": "click|input|navigate|wait|observe",
    "isTerminal": false
  }},
  "highlights": [
    {{ "elementIndex": 0, "explanation": "why this element" }}
  ],
  "done": false,
  "reasoning": "brief explanation"
}}
"""

        cerebras_started = perf_counter()
        response = cerebras_chat(
            [{"role": "user", "content": prompt_text}],
            max_tokens=max_output_tokens,
            temperature=0.0,
            stream=False,
        )
        phase_timings_ms["cerebras_call"] = int((perf_counter() - cerebras_started) * 1000)

        raw_text = extract_cerebras_message(response)
        print(f"Cerebras raw response (/next-step): {raw_text}")

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

        step_payload = parsed.get("step")
        step_instruction = ""
        step_action_type = "click"
        step_is_terminal = False
        if isinstance(step_payload, dict):
            step_instruction = str(step_payload.get("instruction", "")).strip()
            step_action_type = _normalize_action_type(str(step_payload.get("actionType", "")).strip(), step_instruction)
            step_is_terminal = bool(step_payload.get("isTerminal", False))

        text_value = str(parsed.get("text", "")).strip()
        if not step_instruction:
            step_candidates = _extract_numbered_steps_from_text(text_value)
            if step_candidates:
                step_instruction = step_candidates[0]
            elif text_value:
                step_instruction = text_value.splitlines()[0].strip()
            else:
                step_instruction = "Continue with the next visible action on this page."
            step_action_type = _normalize_action_type(step_action_type, step_instruction)

        expected_control = _infer_expected_control_from_instruction(step_instruction)
        highlights = parsed.get("highlights", [])
        if not isinstance(highlights, list):
            highlights = []
        highlights = highlights[:1]

        candidates = _extract_visible_dom_candidates(dom)
        if highlights:
            first = highlights[0] if isinstance(highlights[0], dict) else {}
            if not isinstance(first.get("elementIndex"), int) and candidates and step_action_type not in {"observe", "wait"}:
                ranked = sorted(
                    [(_score_candidate_for_instruction(c, step_instruction, expected_control), c) for c in candidates],
                    key=lambda item: item[0],
                    reverse=True,
                )
                best = ranked[0][1]
                first["elementIndex"] = int(best["index"])
                chosen_label = str(best.get("label") or f'Element {best.get("index")}')
                first["explanation"] = _explanation_for_expected_control(expected_control, chosen_label)
                highlights[0] = first
        elif candidates and step_action_type not in {"observe", "wait"}:
            ranked = sorted(
                [(_score_candidate_for_instruction(c, step_instruction, expected_control), c) for c in candidates],
                key=lambda item: item[0],
                reverse=True,
            )
            best = ranked[0][1]
            chosen_label = str(best.get("label") or f'Element {best.get("index")}')
            highlights = [{
                "elementIndex": int(best["index"]),
                "explanation": _explanation_for_expected_control(expected_control, chosen_label),
            }]

        if vlm_mapped and highlights:
            highlights, _ = _apply_vlm_first_highlight_selection(
                highlights=highlights,
                vlm_mapped=vlm_mapped,
                dom=dom,
                instruction_hints=[step_instruction],
                action_hints=[step_action_type],
            )
            highlights = _constrain_highlights_to_vlm_bounds(highlights, dom, vlm_detections, vlm_mapped)

        highlights = _annotate_highlights_with_vlm_trace(
            highlights,
            vlm_mapped,
            vlm_detections,
            screenshot_provided=bool(screenshot),
            vlm_context=vlm_context,
        )
        for i, h in enumerate(highlights):
            if isinstance(h, dict):
                if not h.get("selectionReason"):
                    h["selectionReason"] = h.get("explanation", "Selected element")
                if not h.get("explanation"):
                    h["explanation"] = h.get("selectionReason", "Selected element")
            else:
                print(f"⚠️ [/next-step] highlight {i} ignored (not an object)")

        if step_action_type in {"observe", "wait"}:
            highlights = []

        reasoning = str(parsed.get("reasoning", "")).strip()
        done = bool(parsed.get("done", False))
        bot_text = text_value or step_instruction
        if _extract_numbered_steps_from_text(bot_text):
            bot_text = step_instruction

        session.add_message("user", f"[next-step] {cleaned_goal}")
        session.add_message("bot", bot_text)

        phase_timings_ms["total_request"] = int((perf_counter() - request_started) * 1000)
        print(f"⏱️ [/next-step] timings_ms={phase_timings_ms}")

        return NextStepResponse(
            text=bot_text,
            step=NextStep(
                instruction=step_instruction,
                actionType=step_action_type,
                isTerminal=step_is_terminal,
            ),
            highlights=highlights,
            sessionId=session.id,
            reasoning=reasoning,
            done=done,
        )
    except Exception as e:
        print(f"Error calling /next-step: {e}")
        phase_timings_ms["total_request"] = int((perf_counter() - request_started) * 1000)
        print(f"⏱️ [/next-step] timings_ms={phase_timings_ms}")
        return NextStepResponse(
            text=f"I hit an error while generating the next step: {str(e)}",
            highlights=[],
            sessionId=session.id,
            done=False,
        )


class ContinueTutorialResponse(BaseModel):
    currentPageHighlights: list
    currentPageStepCount: int
    currentPageRange: dict
    reasoning: Optional[str] = None
    sessionId: str


@app.post("/continue-tutorial", response_model=ContinueTutorialResponse)
@app.post("/continue-tutorial/", response_model=ContinueTutorialResponse, include_in_schema=False)
async def continue_tutorial(
    sessionId: str = Form(...),
    screenshot: Optional[UploadFile] = File(None),
    dom: Optional[str] = Form(None),
    currentPlanStepIndex: int = Form(...),
    completedSteps: str = Form("[]"),
    viewportInfo: Optional[str] = Form(None),
    scrollPosition: Optional[str] = Form(None),
    currentUrl: Optional[str] = Form(None),
    completedStepInstruction: Optional[str] = Form(None),
):
    """
    Continue a multi-page tutorial after navigation.
    Re-generates highlights for the new page using the stored plan.
    Also verifies the previous step was completed by checking the new page context.
    """
    print(f"\n🚀 === /continue-tutorial ===")
    print(f"🧷 Session: {sessionId}, resuming from plan step {currentPlanStepIndex}")
    print(f"🧠 DOM attached? {'yes' if dom else 'no'} | viewportInfo? {'yes' if viewportInfo else 'no'} | screenshot? {'yes' if screenshot else 'no'}")
    if dom:
        dom_line_count = len([line for line in dom.splitlines() if line.strip()])
        print(f"📤 [/continue-tutorial] DOM forwarded for analysis: {dom_line_count} indexed lines")
    if currentUrl:
        print(f"🧭 Current URL: {currentUrl}")
    if completedStepInstruction:
        print(f"✅ Completed step: {completedStepInstruction}")

    session = session_manager.get_session(sessionId)
    if not session:
        print(f"❌ [/continue-tutorial] Missing session for sessionId={sessionId}")
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SESSION_NOT_FOUND",
                "message": "Session not found. Start or resume via /chat first to create a tutorial session."
            },
        )
    if not session.tutorial_plan:
        print(f"❌ [/continue-tutorial] Session has no tutorial plan for sessionId={sessionId}")
        raise HTTPException(
            status_code=409,
            detail={
                "code": "TUTORIAL_PLAN_NOT_FOUND",
                "message": "Tutorial plan missing for this session. Re-run /chat tutorial generation first."
            },
        )

    if not api_key:
        raise HTTPException(status_code=500, detail="API key not configured")
    if VLM_AVAILABLE:
        ensure_vlm_debug_dir(session.id)

    plan = session.tutorial_plan

    # Update completed steps
    try:
        completed = json.loads(completedSteps)
        plan.completed_step_indices = completed
    except json.JSONDecodeError:
        pass

    plan.current_page_start_index = currentPlanStepIndex

    # Build remaining plan steps text
    remaining_steps = plan.plan_steps[currentPlanStepIndex:]
    plan_text = json.dumps(plan.plan_steps, indent=2)
    remaining_text = json.dumps(remaining_steps, indent=2)

    # DOM context
    dom_context = ""
    if dom:
        dom_context = f"""
INDEXED ELEMENTS ON THIS NEW PAGE:
Each interactive element has been assigned a numeric index. Reference elements by their index number.

ANNOTATIONS:
- [VISIBLE]: Element is in current viewport - best to highlight
- [BELOW-SCROLL]: Element is below scroll fold - not visible until scrolling
- [TOP/MID/BOTTOM-SECTION]: Page position (top third, middle third, bottom third)
- in-TAGNAME: Parent element context (e.g., "in-div", "in-form#search")

SELECTION STRATEGY:
1. Match element to the plan step instruction
2. Prefer [VISIBLE] marked elements
3. Use position hints to disambiguate similar elements
4. When multiple matches exist, choose the most prominent one

The list below shows: [index] tagName "visible text" key-attributes in-PARENT [POSITION] [VISIBLE/BELOW-SCROLL]

{dom}
"""

    # Viewport context
    viewport_context = ""
    if viewportInfo:
        viewport_context = f"""
VIEWPORT INFORMATION:
{viewportInfo}

CRITICAL: Only highlight elements marked [VISIBLE]. Never highlight [BELOW-SCROLL] elements.
"""

    vlm_context = ""
    vlm_detections_ct: List[Dict[str, Any]] = []
    vlm_mapped_ct: List[Dict[str, Any]] = []
    if screenshot:
        print(f"📸 [/continue-tutorial] Screenshot received! filename={screenshot.filename}, content_type={screenshot.content_type}")
        # Focus VLM with the next two actionable step queries, then merge detections.
        focused_queries: List[str] = []
        for step in remaining_steps[:2]:
            query_for_step = _build_vlm_query_for_step(step) if isinstance(step, dict) else None
            if query_for_step:
                focused_queries.append(query_for_step)
        if not focused_queries:
            focused_queries = ["find the next actionable visible UI element for this tutorial"]
        screenshot_bytes = await screenshot.read()
        print(f"📸 [/continue-tutorial] Screenshot bytes read: {len(screenshot_bytes)} bytes, queries={focused_queries}")
        vlm_context, vlm_detections_ct, vlm_mapped_ct = _build_vlm_context_from_screenshot_bytes_multi(
            screenshot_bytes=screenshot_bytes,
            queries=focused_queries,
            viewport_info=viewportInfo,
            endpoint_label="/continue-tutorial",
            dom_text=dom,
            session_id=session.id,
        )
        print(f"🎯 [/continue-tutorial] VLM processing complete: detections={len(vlm_detections_ct)}, mapped={len(vlm_mapped_ct)}")
    else:
        print("⚠️ [/continue-tutorial] VLM influence: none (no screenshot in request).")

    # Build verification context
    verification_context = ""
    if currentUrl or completedStepInstruction:
        verification_context = "\nPAGE TRANSITION VERIFICATION:\n"
        if currentUrl:
            verification_context += f"- The user is now on: {currentUrl}\n"
        if completedStepInstruction:
            verification_context += f"- The user just completed: \"{completedStepInstruction}\"\n"
        verification_context += "- VERIFY: Does the current page URL and DOM match what you'd expect after completing that step?\n"
        verification_context += "- If the user appears to be on the WRONG page, note this in your reasoning and still try to map remaining steps.\n"

    prompt = f"""You are continuing a step-by-step tutorial that spans multiple pages.

COMPLETE TUTORIAL PLAN (generated earlier):
{plan_text}

COMPLETED STEPS: {json.dumps(plan.completed_step_indices)}
RESUME FROM: Step {currentPlanStepIndex + 1} (index {currentPlanStepIndex})

REMAINING STEPS:
{remaining_text}

The user has navigated to a NEW PAGE. Below is the fresh screenshot and indexed DOM of this new page.
{verification_context}

{dom_context}

{vlm_context}

🚨 CRITICAL: VLM VISUAL DETECTION USAGE (MANDATORY) 🚨
If `VLM_CONTEXT_JSON` exists with detections > 0:
1. **YOU MUST USE VLM DETECTIONS AS PRIMARY SOURCE** - Do NOT choose from DOM only
2. **ALWAYS use `domSuggestions[].elementIndex`** - This is the VLM-to-DOM mapped result
3. **Cite bbox_absolute** in reasoning: "Used VLM detection bbox_absolute x=420, y=50, width=190, height=16 → elementIndex=4"
4. **IGNORE these VLM labels** (extension UI artifacts):
   - "Site Tutor chat message"
   - "Tutorial step"
   - "Verify Step button"
   - Any text mentioning "Site Tutor" or extension UI
5. **If bestElementIndex is provided** - START with that element, verify it matches visible DOM text, then use it

Flow: Screenshot → VLM detects visual elements → Maps to DOM indices → YOU USE THE MAPPED INDEX

❌ WRONG: "Chose from DOM only (VLM returned 0 detections)" when detections exist
✅ CORRECT: "Used VLM detection bbox_absolute x=420, y=50 → elementIndex=4"

If no VLM detections OR all detections are extension UI artifacts:
- State: "No usable VLM detections (extension UI only)" or "VLM returned 0 detections"
- Then choose from DOM using text matching

{viewport_context}

YOUR TASK:
1. Look at the remaining plan steps (from step {currentPlanStepIndex + 1} onward)
2. Identify which of those remaining steps can be performed on THIS page (marked [VISIBLE])
3. ALWAYS return at least one highlight when visible elements exist - never return empty highlights
4. Make your best guess when multiple similar elements exist
5. Do NOT regenerate the plan -- use the existing plan step instructions
6. For phone purchase flows, prioritize the visible "Buy" control for the selected model and treat arrival at the buy portal/configurator as terminal for this tutorial (do not add checkout/payment actions).

ELEMENT SELECTION RULES (CRITICAL):
- SPECIFICITY FIRST: Choose the element whose text MOST PRECISELY matches the plan step instruction, with the FEWEST extra/surplus words.
  Example: instruction says "Click iPhone" → pick element "iPhone" NOT "iPhone Pro" or "iPhone Pro Max"
- Exact text match from plan + [VISIBLE] → Use this (highest priority)
- Near-exact match (same words, minimal surplus) + [VISIBLE] → Use this
- Partial match + [VISIBLE] → Use only if no better match exists
- No visible match → Include scroll instruction, still highlight best available guess
- Match control type to action:
  - type/enter/fill -> input or textarea/select controls only
  - click/buy/continue/submit -> button/link controls only
  - open/go to/navigate -> link controls only
- Do NOT highlight container wrappers (`div`, `section`, `ul`, `li`, `main`) when a real control is available.
- CUSTOMER POV: prioritize controls an end-user customer is meant to use in the main page flow.
- Avoid sticky/fixed/global nav bars (top scroll-triggered bars) when the same action exists in-page, unless the instruction explicitly asks for nav/header/menu.

Return your response as JSON:
{{{{
  "currentPageHighlights": [
    {{{{"elementIndex": 3, "explanation": "Enter repository name here", "planStepNumber": 2}}}}
  ],
  "currentPageStepCount": 3,
  "currentPageRange": {{{{"startIndex": {currentPlanStepIndex}, "endIndex": {currentPlanStepIndex}}}}},
  "reasoning": "Your thought process..."
}}}}

CRITICAL:
- ALWAYS include highlights for [VISIBLE] elements when they exist
- "planStepNumber" in each highlight must match the stepNumber from the plan
- "currentPageRange" startIndex and endIndex are indices into the original planSteps array
- ONLY include [VISIBLE] marked elements in highlights
- Use the indexed element list to find EXACT element indices, or make educated guesses if inexact
- Never return empty currentPageHighlights if any [VISIBLE] elements could reasonably match the step
"""

    try:
        if screenshot:
            print("Continue-tutorial screenshot processed via VLM and passed to Cerebras as visual context.")

        response = cerebras_chat(
            [{"role": "user", "content": prompt}],
            max_tokens=max_output_tokens,
            temperature=0.0,
            stream=False,
        )

        raw_text = extract_cerebras_message(response)

        print(f"Continue-tutorial raw response: {raw_text}")

        # Clean markdown code blocks
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

        highlights = parsed.get("currentPageHighlights", [])
        page_range = parsed.get("currentPageRange", {"startIndex": currentPlanStepIndex, "endIndex": currentPlanStepIndex})
        reasoning = parsed.get("reasoning", "")

        # Skip model-specificity refinement in continue-tutorial — plan instructions are already specific.
        # Only VLM constraint (applied below) should override highlights.

        if isinstance(highlights, list) and highlights:
            remaining_instruction_hints: List[str] = []
            remaining_action_hints: List[str] = []
            for step in remaining_steps:
                if isinstance(step, dict):
                    ins = str(step.get("instruction", "")).strip()
                    if ins:
                        remaining_instruction_hints.append(ins)
                        remaining_action_hints.append(str(step.get("actionType", "")).strip().lower())

            if vlm_mapped_ct:
                vlm_first_highlights, vlm_first_changed = _apply_vlm_first_highlight_selection(
                    highlights,
                    vlm_mapped_ct,
                    dom,
                    remaining_instruction_hints,
                    remaining_action_hints,
                )
                if vlm_first_changed:
                    highlights = vlm_first_highlights
                    print("🎯 [/continue-tutorial] applied VLM-first highlight selection (heuristic control-refine skipped)")
            else:
                control_refined_highlights, _, controls_changed = _refine_highlights_to_control_type(
                    highlights,
                    dom,
                    remaining_instruction_hints,
                    remaining_action_hints
                )
                if controls_changed:
                    highlights = control_refined_highlights
                    print("🎯 [/continue-tutorial] refined highlights by control type (input/button/link)")

        # Constrain highlights to VLM bounding boxes
        if vlm_mapped_ct and isinstance(highlights, list) and highlights:
            highlights = _constrain_highlights_to_vlm_bounds(
                highlights, dom, vlm_detections_ct, vlm_mapped_ct
            )
        highlights = _annotate_highlights_with_vlm_trace(
            highlights if isinstance(highlights, list) else [],
            vlm_mapped_ct,
            vlm_detections_ct,
            screenshot_provided=bool(screenshot),
            vlm_context=vlm_context,
        )

        # CRITICAL: Ensure selectionReason is ALWAYS set for frontend
        # _annotate_highlights_with_vlm_trace should have set it, but verify
        if isinstance(highlights, list):
            for i, h in enumerate(highlights):
                if isinstance(h, dict):
                    # If no selectionReason (shouldn't happen), use explanation as fallback
                    if not h.get("selectionReason"):
                        fallback_reason = h.get("explanation", "Element selected for this step")
                        h["selectionReason"] = fallback_reason
                        print(f"⚠️ [/continue-tutorial] Highlight {i} missing selectionReason, using fallback: {fallback_reason[:50]}")
                    # Always ensure explanation field exists for backward compatibility
                    if not h.get("explanation"):
                        h["explanation"] = h.get("selectionReason", "Selected element")

        print(f"New page highlights: {len(highlights)}")
        print(f"Page range: {page_range}")
        for i, h in enumerate(highlights):
            print(f"  Highlight {i+1} → elementIndex={h.get('elementIndex', 'none')}, planStep={h.get('planStepNumber', '?')}, reason={h.get('selectionReason', 'none')[:50]}")
        print("========================\n")

        # Update session plan state
        plan.current_page_start_index = page_range.get("startIndex", currentPlanStepIndex)

        return ContinueTutorialResponse(
            currentPageHighlights=highlights,
            currentPageStepCount=parsed.get("currentPageStepCount", len(highlights)),
            currentPageRange=page_range,
            reasoning=reasoning,
            sessionId=session.id,
        )

    except json.JSONDecodeError:
        print(f"Failed to parse continue-tutorial JSON: {raw_text}")
        raise HTTPException(status_code=500, detail="Failed to parse AI response")
    except Exception as e:
        print(f"Continue-tutorial error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class VerifyStepRequest(BaseModel):
    stepInstruction: str
    screenshot: Optional[str] = None  # base64 encoded
    dom: Optional[str] = None
    clickedElement: str = ""
    currentUrl: Optional[str] = None  # Current URL so AI knows where user is
    sessionId: Optional[str] = None  # Session ID for context

class VerifyStepResponse(BaseModel):
    isCorrect: bool
    confidence: float
    reason: str

def _normalize_url_route(url: Optional[str]) -> str:
    if not url:
        return ""
    try:
        parsed = urlparse(url)
        path = parsed.path or "/"
        return f"{parsed.scheme}://{parsed.netloc}{path}".rstrip("/")
    except Exception:
        return str(url).strip().rstrip("/")

def _instruction_is_input_like(instruction: str) -> bool:
    lower = (instruction or "").lower()
    input_terms = (
        "type",
        "enter",
        "fill",
        "input",
        "password",
        "email",
        "address",
        "shipping",
        "payment",
        "card",
    )
    return any(term in lower for term in input_terms)

def _instruction_is_navigation_like(instruction: str) -> bool:
    lower = (instruction or "").lower()
    nav_terms = (
        "open",
        "go to",
        "navigate",
        "visit",
        "click",
        "tap",
        "press",
        "select",
        "choose",
        "pick",
        "model",
        "link",
        "page",
    )
    return any(term in lower for term in nav_terms)

@app.post("/verify", response_model=VerifyStepResponse)
async def verify_step(request: VerifyStepRequest):
    """
    Verify if a tutorial step was completed correctly.
    Uses VLM (Claude) with screenshot when available, falls back to Cerebras text-only.
    """
    if not api_key:
        return VerifyStepResponse(
            isCorrect=False,
            confidence=0.0,
            reason="API key not configured"
        )

    try:
        # Session-aware URL transition guardrail:
        # if user navigated to a different route and step is navigation-like,
        # count the step as complete without requiring extra in-page interaction.
        session = session_manager.get_session(request.sessionId) if request.sessionId else None
        prev_route = _normalize_url_route(session.last_verified_url) if session else ""
        current_route = _normalize_url_route(request.currentUrl)
        route_changed = bool(prev_route and current_route and prev_route != current_route)

        if route_changed and _instruction_is_navigation_like(request.stepInstruction) and not _instruction_is_input_like(request.stepInstruction):
            if session:
                session.last_verified_url = request.currentUrl
            reason = (
                f"Accepted as completed because the route changed from '{prev_route}' to '{current_route}' "
                f"after this navigation step."
            )
            print(f"✅ [/verify] URL-change completion accepted | {reason}")
            return VerifyStepResponse(
                isCorrect=True,
                confidence=0.93,
                reason=reason
            )

        # Include current URL context if provided
        url_context = ""
        if request.currentUrl:
            url_context = f"\nCurrent Page URL: {request.currentUrl}"
            if prev_route:
                url_context += f"\nPrevious Verified URL: {prev_route}"
            url_context += f"\nRoute Changed Since Last Verify: {'yes' if route_changed else 'no'}"

        verify_text_prompt = f"""You are a tutorial verification assistant. Determine if the user correctly completed the following step.

Step Instruction: {request.stepInstruction}
User clicked on: {request.clickedElement}{url_context}

Page Context (DOM):
{request.dom if request.dom else "(No DOM provided)"}

Based on what you see, did the user successfully complete this step? Consider the current URL and page context to determine if the user is on the expected page after completing the step.

Respond ONLY with valid JSON:
{{
  "isCorrect": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}}"""

        raw_text = None

        # Try VLM (Claude) with screenshot first
        if request.screenshot and VLM_AVAILABLE:
            try:
                claude_client = initialize_claude()
                if claude_client:
                    print(f"🔍 [/verify] Using VLM (Claude) for step verification with screenshot")
                    # Build multimodal message with screenshot
                    content = [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": request.screenshot,
                            },
                        },
                        {
                            "type": "text",
                            "text": verify_text_prompt,
                        },
                    ]
                    vlm_response = claude_client.messages.create(
                        model="claude-sonnet-4-5-20250929",
                        max_tokens=300,
                        messages=[{"role": "user", "content": content}],
                    )
                    raw_text = vlm_response.content[0].text
                    print(f"✅ [/verify] VLM verification response received")
            except Exception as vlm_err:
                print(f"⚠️ [/verify] VLM verification failed, falling back to Cerebras: {vlm_err}")
                raw_text = None

        # Fallback to Cerebras text-only
        if raw_text is None:
            print(f"🔍 [/verify] Using Cerebras (text-only) for step verification")
            response = cerebras_chat(
                [{"role": "user", "content": verify_text_prompt}],
                max_tokens=200,
                temperature=0.0,
                stream=False,
            )
            raw_text = extract_cerebras_message(response)

        # Parse JSON response
        try:
            result = json.loads(raw_text.strip())
        except json.JSONDecodeError:
            extracted = extract_json_object(raw_text)
            if extracted:
                result = json.loads(extracted.strip())
            else:
                raise

        response_payload = VerifyStepResponse(
            isCorrect=result.get("isCorrect", False),
            confidence=float(result.get("confidence", 0.5)),
            reason=result.get("reason", "")
        )
        if session and request.currentUrl:
            session.last_verified_url = request.currentUrl
        return response_payload

    except Exception as e:
        print(f"Verification error: {e}")
        return VerifyStepResponse(
            isCorrect=False,
            confidence=0.0,
            reason=f"Verification failed: {str(e)}"
        )

## /capture-desktop endpoint REMOVED — desktop-level screenshots include non-browser
## content (IDE, terminal, OS UI) which confuses the VLM. The extension now only uses
## chrome.tabs.captureVisibleTab() which captures browser tab content exclusively.


class VLMDetectRequest(BaseModel):
    screenshot: str  # base64 encoded image
    query: str  # natural language query
    viewport_width: int
    viewport_height: int


class VLMDetection(BaseModel):
    label: str
    confidence: float
    bbox: Dict[str, float]  # normalized 0-1 coordinates
    bbox_absolute: Dict[str, int]  # absolute pixel coordinates


class VLMDetectResponse(BaseModel):
    detections: List[VLMDetection]
    model_latency_ms: int
    reasoning: str
    error: Optional[str] = None
    diagnostics: Optional[Dict[str, Any]] = None


@app.post("/vlm-detect", response_model=VLMDetectResponse)
async def vlm_detect(request: VLMDetectRequest):
    """
    Detect UI elements using Vision-Language Model.

    This endpoint uses a local Qwen2.5-VL-8B model to visually identify
    elements in a screenshot. Returns normalized bounding boxes (0-1 coordinates)
    that can be mapped to DOM elements via Intersection over Union (IoU).

    Example request:
    {
      "screenshot": "base64_image_data",
      "query": "find the submit button",
      "viewport_width": 1920,
      "viewport_height": 1080
    }

    Example response:
    {
      "detections": [
        {
          "label": "submit button",
          "confidence": 0.92,
          "bbox": {"x": 0.65, "y": 0.45, "width": 0.08, "height": 0.03},
          "bbox_absolute": {"x": 1248, "y": 486, "width": 154, "height": 32}
        }
      ],
      "model_latency_ms": 1456,
      "reasoning": "Found button matching 'submit' in center-right region"
    }
    """
    print(f"\n🔍 [/vlm-detect] VLM element detection request")
    print(f"   Query: {request.query}")
    print(f"   Viewport: {request.viewport_width}x{request.viewport_height}")

    # Check if VLM is available
    if not VLM_AVAILABLE:
        return VLMDetectResponse(
            detections=[],
            model_latency_ms=0,
            reasoning="VLM dependencies not installed",
            error="VLM module not available. Install dependencies: pip install torch transformers accelerate"
        )

    try:
        # Decode base64 image
        image = decode_base64_image(request.screenshot)
        if image is None:
            return VLMDetectResponse(
                detections=[],
                model_latency_ms=0,
                reasoning="Failed to decode screenshot",
                error="Invalid base64 image data"
            )

        print(f"   Image decoded: {image.size[0]}x{image.size[1]} pixels")

        # Detect elements using VLM
        result = detect_elements(
            image=image,
            query=request.query,
            viewport_width=request.viewport_width,
            viewport_height=request.viewport_height,
            session_id=None,
        )

        print(f"   Detections: {len(result['detections'])}")
        print(f"   Latency: {result['model_latency_ms']}ms")

        if result.get("detections"):
            for i, det in enumerate(result["detections"]):
                bbox_norm = det.get("bbox", {}) or {}
                bbox_abs = det.get("bbox_absolute", {}) or {}
                norm_w = bbox_norm.get("width")
                norm_h = bbox_norm.get("height")
                abs_w = bbox_abs.get("width")
                abs_h = bbox_abs.get("height")
                abs_area = (abs_w * abs_h) if isinstance(abs_w, (int, float)) and isinstance(abs_h, (int, float)) else None
                print(
                    f"      [{i}] {det['label']} "
                    f"| conf={det.get('confidence')} "
                    f"| bbox_norm={bbox_norm} (w={norm_w}, h={norm_h}) "
                    f"| bbox_abs={bbox_abs} (w={abs_w}px, h={abs_h}px, area={abs_area}px^2)"
                )

        return VLMDetectResponse(
            detections=result["detections"],
            model_latency_ms=result["model_latency_ms"],
            reasoning=result["reasoning"],
            error=result.get("error"),
            diagnostics=result.get("diagnostics"),
        )

    except Exception as e:
        print(f"❌ VLM detection error: {e}")
        import traceback
        traceback.print_exc()

        return VLMDetectResponse(
            detections=[],
            model_latency_ms=0,
            reasoning=f"VLM detection failed: {str(e)}",
            error=str(e),
            diagnostics={"error": str(e)},
        )


@app.get("/vlm-health")
async def vlm_health():
    """
    Check VLM availability and status.

    Returns:
    {
      "vlm_available": true/false,
      "provider": "claude-api",
      "model_name": "claude-sonnet-4-5-20250929",
      "api_key_configured": true/false,
      "error": "error message if failed"
    }
    """
    if not VLM_AVAILABLE:
        return {
            "vlm_available": False,
            "provider": "cloud",
            "error": "VLM dependencies not installed (pip install anthropic)"
        }

    try:
        client = initialize_claude()

        if client is None:
            return {
                "vlm_available": True,
                "provider": "claude-api",
                "api_key_configured": False,
                "error": "CLAUDE_API_KEY not configured"
            }

        return {
            "vlm_available": True,
            "provider": "claude-api",
            "model_name": os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5-20250929"),
            "api_key_configured": True,
            "error": None
        }

    except Exception as e:
        return {
            "vlm_available": True,
            "provider": "claude-api",
            "error": str(e)
        }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
