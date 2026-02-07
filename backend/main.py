import os
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from pydantic import BaseModel
from typing import List, Optional, Dict, Any, Tuple
import json
from dotenv import load_dotenv
from PIL import ImageGrab, Image
import io
import asyncio
from session_manager import SessionManager, TutorialPlanState
import base64
import re
from cerebras.cloud.sdk import Cerebras
from cerebras.cloud.sdk import APIError, APIConnectionError, RateLimitError

# VLM imports - using cloud Claude API
try:
    from vlm_detector_cloud import detect_elements, decode_base64_image, initialize_claude
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
            "is_inputish": is_inputish,
            "is_buttonish": is_buttonish,
            "is_linkish": is_linkish,
            "combined_text": combined,
        })

    return candidates

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
    lower = instruction.lower()
    if any(k in lower for k in ("type ", "enter ", "fill ", "input ", "search", "email", "password", "name", "address", "zip", "code", "phone")):
        return "input"
    if any(k in lower for k in ("open ", "go to", "navigate", "visit ", "link", " tab", "menu item")):
        return "link"
    if any(k in lower for k in ("select ", "choose ", "pick ")):
        return "select"
    if any(k in lower for k in ("click", "tap", "press", "buy", "add to", "checkout", "submit", "place order", "continue")):
        return "button"
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
            "expectedResult": f'The {topic_label} model list page is visible.',
            "expectsPageChange": True,
            "pageDescription": f"{topic_label} category page",
            "isTerminal": False,
        },
        {
            "stepNumber": 2,
            "instruction": f'Click "{model_label}"',
            "actionType": "click",
            "expectedResult": f'The "{model_label}" product page opens.',
            "expectsPageChange": True,
            "pageDescription": f"{model_label} product page",
            "isTerminal": False,
        },
        {
            "stepNumber": 3,
            "instruction": f'Confirm you are on the buy page for "{model_label}"',
            "actionType": "wait",
            "expectedResult": f'A Buy or Add to Bag option for "{model_label}" is visible.',
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

def _derive_expected_result(instruction: str, action_type: str) -> str:
    quoted = re.search(r'"([^"]+)"', instruction or "")
    label = quoted.group(1).strip() if quoted else ""

    if action_type == "input":
        return f'The "{label}" field contains your entered value.' if label else "The target field contains your entered value."
    if action_type == "navigate":
        return f'The "{label}" page or section is open.' if label else "The requested page is open."
    if action_type == "scroll":
        return f'The "{label}" section is visible in the viewport.' if label else "The target section is visible in the viewport."
    if action_type == "wait":
        return "The page finishes loading and the target content is visible."
    if label:
        return f'The "{label}" target opens or becomes active.'

    instruction_text = (instruction or "").strip().rstrip(".")
    if instruction_text:
        return f'The result of this step is visible: {instruction_text}.'
    return "The step outcome is visible on the page."

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
        expected_result = str(raw_step.get("expectedResult", "")).strip()
        if not expected_result:
            expected_result = _derive_expected_result(instruction, action_type)

        expects_page_change_raw = raw_step.get("expectsPageChange")
        expects_page_change = bool(expects_page_change_raw) if isinstance(expects_page_change_raw, bool) else (action_type == "navigate")

        normalized_steps.append({
            "stepNumber": len(normalized_steps) + 1,
            "instruction": instruction,
            "actionType": action_type,
            "expectedResult": expected_result,
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


def _build_vlm_context_from_screenshot_bytes(
    screenshot_bytes: bytes,
    query: str,
    viewport_info: Optional[str],
    endpoint_label: str
) -> str:
    """Run VLM on a screenshot and return prompt context for downstream LLM calls."""
    if not screenshot_bytes:
        print(f"🤖 [{endpoint_label}] VLM influence: none (empty screenshot payload).")
        return ""

    if not VLM_AVAILABLE:
        print(f"🤖 [{endpoint_label}] VLM influence: none (VLM backend unavailable).")
        return ""

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

        vlm_result = detect_elements(
            image=image,
            query=query,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
        )

        detections = vlm_result.get("detections", []) or []
        detections = _rank_vlm_detections(detections, query)
        print(f"🤖 [{endpoint_label}] VLM detections={len(detections)} latency={vlm_result.get('model_latency_ms')}ms")

        if not detections:
            return """
VLM VISUAL DETECTIONS:
No confident visual detections were returned for this screenshot/query.
"""

        vlm_lines: List[str] = []
        for i, det in enumerate(detections[:5]):
            bbox_norm = det.get("bbox", {}) or {}
            bbox_abs = det.get("bbox_absolute", {}) or {}
            norm_w = bbox_norm.get("width")
            norm_h = bbox_norm.get("height")
            abs_w = bbox_abs.get("width")
            abs_h = bbox_abs.get("height")
            print(
                f"🤖 [{endpoint_label}]   [{i}] {det.get('label')} "
                f"| conf={det.get('confidence')} "
                f"| bbox_norm(w={norm_w}, h={norm_h}) "
                f"| bbox_abs(w={abs_w}px, h={abs_h}px)"
            )
            vlm_lines.append(
                f"- label={det.get('label')}; conf={det.get('confidence')}; "
                f"bbox_norm={bbox_norm}; bbox_abs={bbox_abs}"
            )

        best = detections[0] if detections else {}
        return f"""
VLM VISUAL DETECTIONS (derived from the screenshot):
Use these detections as visual hints when selecting elementIndex values from the indexed DOM.
Prioritize the highest-ranked candidate unless DOM evidence strongly contradicts it.
BEST_VLM_CANDIDATE: label={best.get("label")}; conf={best.get("confidence")}; bbox_abs={best.get("bbox_absolute")}
{chr(10).join(vlm_lines)}
"""
    except Exception as vlm_error:
        print(f"⚠️ [{endpoint_label}] VLM assist failed: {vlm_error}")
        return """
VLM VISUAL DETECTIONS:
VLM was attempted but failed for this request. Fall back to DOM-guided reasoning.
"""

app = FastAPI()

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

@app.on_event("startup")
async def startup_event():
    """Periodic cleanup of expired sessions"""
    async def cleanup_task():
        while True:
            await asyncio.sleep(300)  # Every 5 minutes
            session_manager.cleanup_expired_sessions()
    asyncio.create_task(cleanup_task())

class Highlight(BaseModel):
    selector: str = ""
    explanation: str
    elementIndex: Optional[int] = None

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
    print(f"📥 [/chat] Received message: {message}")

    # Get or create session
    session = session_manager.get_or_create_session(sessionId)
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
        vlm_context = ""
        if screenshot:
            print(f"🖼️ [/chat] Screenshot received ({screenshot.filename}); preparing VLM assist.")
            screenshot_bytes = await screenshot.read()
            vlm_context = _build_vlm_context_from_screenshot_bytes(
                screenshot_bytes=screenshot_bytes,
                query=message,
                viewport_info=viewportInfo,
                endpoint_label="/chat"
            )
        else:
            print("🖼️ [/chat] No screenshot provided.")
            print("🤖 [/chat] VLM influence: none (no screenshot in /chat request).")

        # Store user message in session
        session.add_message('user', message)

        prompt_text = ""
        # Detect if this is a "select" or "highlight" instruction
        is_selection_request = any(keyword in message.lower() for keyword in [
            'select', 'highlight', 'show me', 'point to', 'find', 'where is',
            'click on', 'identify', 'mark', 'circle'
        ])

        selection_instructions = ""
        if is_selection_request:
            selection_instructions = """
IMPORTANT: The user wants you to SELECT/HIGHLIGHT a specific element on the page.
- You MUST return at least one highlight with the element's numeric index from the indexed element list below.
- Cross-reference the screenshot with the indexed element list to find the correct element index.
"""

        # Enhanced instructions for finding multiple elements (like "all buttons")
        multiple_elements_instruction = ""
        if any(keyword in message.lower() for keyword in ['all', 'every', 'each']):
            multiple_elements_instruction = """
CRITICAL: The user wants to find MULTIPLE elements. Generate a SEPARATE highlight entry for EACH distinct element you can identify from the indexed list.
"""

        # Include indexed DOM if provided
        dom_context = ""
        if dom:
            dom_context = f"""
INDEXED ELEMENTS ON THIS PAGE:
Each interactive element has been assigned a numeric index. Reference elements by their index number.

ANNOTATIONS:
- [VISIBLE]: Element is in current viewport - best to highlight
- [BELOW-SCROLL]: Element is below scroll fold - not visible until scrolling
- [TOP/MID/BOTTOM-SECTION]: Page position (top third, middle third, bottom third)
- in-TAGNAME: Parent element context (e.g., "in-div", "in-form#search")

SELECTION PRIORITY:
1. Find the element whose text MOST PRECISELY matches the instruction - fewest extra words wins
2. Among matching elements, prefer those marked [VISIBLE]
3. When multiple similar elements exist, choose the one whose text most closely matches the instruction WITHOUT extra qualifiers (e.g., for "Buy", prefer "Buy" over "Buy Now" over "Buy Now and Save")
4. When uncertain, make your best educated guess - never return empty highlights

The list below shows: [index] tagName "visible text" key-attributes in-PARENT [POSITION] [VISIBLE/BELOW-SCROLL]

{dom}
"""

        # Include viewport information if provided
        viewport_context = ""
        if viewportInfo:
            viewport_context = f"""
VIEWPORT INFORMATION:
{viewportInfo}

CRITICAL RULES FOR ELEMENT SELECTION:
1. ONLY return elementIndex for elements marked [VISIBLE]
2. Never highlight elements marked [BELOW-SCROLL] - user can't see them until scrolling
3. If the next step requires a [BELOW-SCROLL] element, include scroll instructions in your response
4. Always make your best guess - don't return empty highlights
"""

        # Include completion history if provided
        history_context = ""
        if completionHistory:
            history_context = f"""
PRIOR LEARNING HISTORY:
The user has previously completed these tutorials on this site:
{completionHistory}
You can skip basics they already know and build on prior knowledge.
"""

        # Include tutorial context if provided
        tutorial_context = ""
        if tutorialContext:
            tutorial_context = f"""
CURRENT TUTORIAL CONTEXT:
The user is currently in a step-by-step tutorial. Use this to avoid restarting from step 1.
{tutorialContext}
If the user asks a question while mid-tutorial, continue from the current step and reference the next best action.
"""

        # Start tutorial mode only when user intent is explicit, or when continuing an active tutorial.
        normalized_message = message.lower().strip()
        tutorial_intent_patterns = [
            "tutorial",
            "step by step",
            "step-by-step",
            "walk me through",
            "guide me",
            "show me how",
            "teach me how",
            "how to ",
            "how do i ",
            "help me do",
            "what should i click",
        ]
        is_tutorial_request = bool(tutorialContext) or any(
            pattern in normalized_message for pattern in tutorial_intent_patterns
        )

        tutorial_instruction = ""
        if is_tutorial_request:
            tutorial_instruction = """
CRITICAL: The user is asking for a TUTORIAL or STEP-BY-STEP GUIDE.

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

ELEMENT SELECTION RULES (CRITICAL - follow strictly):
1. SPECIFICITY FIRST: Choose the element whose visible text MOST PRECISELY matches the target, with the FEWEST extra words.
   - Query "iPhone" → element "iPhone" (NOT "iPhone Pro" or "iPhone Pro Max")
   - Query "iPhone Pro" → element "iPhone Pro" (NOT "iPhone" or "iPhone Pro Max")
   - Query "Add to Cart" → element "Add to Cart" (NOT "Add to Cart and Continue Shopping")
   - The BEST match is the one where the element text is closest in length and content to the query.
2. EXACT > NEAR-EXACT > PARTIAL: Prefer exact text matches over partial ones. If no exact match, prefer the element with the LEAST surplus text beyond the query words.
3. VISIBLE PREFERENCE: Among equally specific matches, prefer [VISIBLE] elements.
4. ALWAYS GUESS: If no good match exists, still return your best guess from available elements - never return empty highlights.

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
      {{"stepNumber": 1, "instruction": "Click the New button", "actionType": "click", "expectedResult": "The repository creation page opens.", "expectsPageChange": true, "pageDescription": "GitHub main page", "isTerminal": false}},
      {{"stepNumber": 2, "instruction": "Enter repository name", "actionType": "input", "expectedResult": "The repository name field contains your typed name.", "expectsPageChange": false, "pageDescription": "Repository creation form", "isTerminal": false}},
      {{"stepNumber": 3, "instruction": "Choose visibility", "actionType": "click", "expectedResult": "The selected visibility option is active.", "expectsPageChange": false, "pageDescription": "Repository creation form", "isTerminal": false}},
      {{"stepNumber": 4, "instruction": "Click Create repository", "actionType": "click", "expectedResult": "The new repository page is open.", "expectsPageChange": true, "pageDescription": "Repository creation form", "isTerminal": true}}
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
- Every step MUST include "expectedResult" with a concrete, checkable outcome visible in URL, page text, heading, or field state.
- Include exactly one terminal step: set "isTerminal": true only on the final step.
- Use the indexed element list to find EXACT element indices for current-page steps only
- If no exact match exists, make your best guess from available [VISIBLE] elements
- Match control type to instruction:
  - "type/enter/fill" -> select an input/textarea/select field, not a container
  - "click/buy/continue/submit" -> select a button-like or clickable control
  - "open/go to/navigate" -> select a link-like control
- Never target generic containers (`div`, `section`, `ul`, `li`, `main`, `article`) when a clickable/input control exists.
"""
        else:
            tutorial_instruction = """
The user is asking a normal question, not explicitly requesting a tutorial.
- Do NOT force a numbered tutorial.
- Answer directly and conversationally.
- Return highlights only if they are useful for what the user asked right now.
"""

        prompt_text = f"""
You are a Site Tutor, an expert web developer and UI guide.
Your goal is to answer the user's question about the website screenshot provided.
You must also identify specific HTML elements on the screen that are relevant to your answer so we can highlight them.

User Question: "{message}"

{tutorial_instruction}

{selection_instructions}

{multiple_elements_instruction}

{dom_context}

{vlm_context}

{viewport_context}

{history_context}

{tutorial_context}

AUTOMATION CAPABILITY:
You have the ability to automate actions for the user. When the user expresses frustration, gives up, or asks you to do something for them, you can take control and automate the task.

Detect phrases like "I give up", "Just do it for me", "Can you do it", "You do it", "Help me do this", or any expression of wanting you to take over.

When automation is appropriate, analyze what the user is trying to do and generate the correct automation action:
1. **Navigate to a URL** - Use when user wants to go to a specific page
2. **Click an element** - Use when user wants to click something on the current page

IMPORTANT: Only provide automation when the user clearly wants you to take over.

ELEMENT REFERENCING:
- Each element in the indexed list has a numeric index (e.g. [0], [1], [2]).
- When identifying elements, use the "elementIndex" field with the numeric index from the list.
- Cross-reference the screenshot with the indexed element list to pick the correct index.
- If the indexed list is not available, fall back to a CSS selector in the "selector" field.

SPECIFICITY MATCHING EXAMPLES:
- DOM has: [5] a "iPhone" [VISIBLE], [6] a "iPhone Pro" [VISIBLE], [7] a "iPhone Pro Max" [VISIBLE]
  - User says "iPhone" → elementIndex: 5 (exact match, NOT 6 or 7)
  - User says "iPhone Pro" → elementIndex: 6 (exact match, NOT 5 or 7)
  - User says "iPhone Pro Max" → elementIndex: 7 (exact match, NOT 5 or 6)
- DOM has: [10] button "Add to Bag" [VISIBLE], [11] button "Add to Bag - Express" [VISIBLE]
  - User says "Add to Bag" → elementIndex: 10 (NOT 11)
- DOM has: [20] a "Settings" [VISIBLE], [21] a "Settings and Privacy" [VISIBLE]
  - User says "Settings" → elementIndex: 20 (NOT 21)

Return your response strictly as a JSON object with this format:
{{
  "text": "Your conversational answer here...",
  "highlights": [
    {{ "elementIndex": 5, "explanation": "Brief label for the highlight" }}
  ],
  "automation": null,
  "reasoning": "Explain your thought process: What elements did you see? Why did you pick these specific element indices? How did you match them to each step? This helps debug element selection."
}}

OR for automation:
{{
  "text": "Your conversational answer here...",
  "highlights": [],
  "automation": {{
    "type": "navigate",
    "url": "https://example.com/path"
  }},
  "reasoning": "Your thought process here..."
}}

IMPORTANT: Always include the "reasoning" field with your thought process for debugging.
If no automation is needed, set "automation": null.
If you cannot find an element index, you may include a "selector" field as a CSS selector fallback.
"""

        if screenshot:
            prompt_text += "\n(Screenshot provided but omitted; current Cerebras models are text-only.)"
        else:
            prompt_text += "\n(No screenshot provided, answer based on general web knowledge if possible)"

        response = cerebras_chat(
            [{"role": "user", "content": prompt_text}],
            max_tokens=max_output_tokens,
            temperature=0.0,
            stream=False,
        )

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

        topic_context = f"{message} {tutorialContext or ''}"
        topic = _infer_topic_from_message(topic_context)
        raw_highlights = parsed.get("highlights", [])
        if isinstance(raw_highlights, list) and raw_highlights:
            refined_highlights, chosen_label = _refine_highlights_to_specific_model(
                raw_highlights,
                dom,
                topic,
                str(parsed.get("text", ""))
            )
            parsed["highlights"] = refined_highlights
            if chosen_label:
                parsed["text"] = _rewrite_first_generic_model_line(str(parsed.get("text", "")), chosen_label)
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
                    current_range = tutorial_plan_data.get("currentPageRange", {})
                    start_idx = int(current_range.get("startIndex", 0)) if isinstance(current_range, dict) else 0
                    plan_steps = tutorial_plan_data.get("planSteps")
                    if isinstance(plan_steps, list):
                        for i, step_text in enumerate(control_refined_steps):
                            plan_i = start_idx + i
                            if plan_i < len(plan_steps) and isinstance(plan_steps[plan_i], dict):
                                plan_steps[plan_i]["instruction"] = step_text
                                inferred = _infer_expected_control_from_instruction(step_text)
                                if inferred == "input":
                                    plan_steps[plan_i]["actionType"] = "input"
                                elif inferred in {"button", "link", "select"}:
                                    plan_steps[plan_i]["actionType"] = "click"

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
                print(f"  Step {i+1} → elementIndex={h.get('elementIndex', 'none')}, explanation=\"{h.get('explanation', '')}\"")
        print("========================\n")

        # Store bot message in session
        session.add_message('bot', bot_response_text)

        # Store tutorial plan in session if present
        if tutorial_plan_data and isinstance(tutorial_plan_data, dict):
            plan_steps = tutorial_plan_data.get("planSteps", [])
            session.tutorial_plan = TutorialPlanState(
                plan_steps=plan_steps,
                completed_step_indices=[],
                current_page_start_index=tutorial_plan_data.get("currentPageRange", {}).get("startIndex", 0),
                original_query=message,
                title=tutorial_plan_data.get("title", "Tutorial"),
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

        return ChatResponse(
            text=bot_response_text,
            highlights=parsed.get("highlights", []),
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
        return ChatResponse(
            text=f"I encountered an error analyzing the page: {str(e)}",
            highlights=[],
            automation=None,
            sessionId=session.id
        )


class ContinueTutorialResponse(BaseModel):
    currentPageHighlights: list
    currentPageStepCount: int
    currentPageRange: dict
    reasoning: Optional[str] = None
    sessionId: str


@app.post("/continue-tutorial", response_model=ContinueTutorialResponse)
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
    if not session or not session.tutorial_plan:
        raise HTTPException(status_code=404, detail="Session or tutorial plan not found")

    if not api_key:
        raise HTTPException(status_code=500, detail="API key not configured")

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
    if screenshot:
        # Use next few remaining step instructions to focus VLM on immediate actions.
        remaining_instructions: List[str] = []
        for step in remaining_steps[:3]:
            if isinstance(step, dict):
                instruction = str(step.get("instruction", "")).strip()
                if instruction:
                    remaining_instructions.append(instruction)
        vlm_query = " ; ".join(remaining_instructions) if remaining_instructions else "find the next actionable UI element for this tutorial"
        screenshot_bytes = await screenshot.read()
        vlm_context = _build_vlm_context_from_screenshot_bytes(
            screenshot_bytes=screenshot_bytes,
            query=vlm_query,
            viewport_info=viewportInfo,
            endpoint_label="/continue-tutorial"
        )
    else:
        print("🤖 [/continue-tutorial] VLM influence: none (no screenshot in request).")

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

{viewport_context}

YOUR TASK:
1. Look at the remaining plan steps (from step {currentPlanStepIndex + 1} onward)
2. Identify which of those remaining steps can be performed on THIS page (marked [VISIBLE])
3. ALWAYS return at least one highlight when visible elements exist - never return empty highlights
4. Make your best guess when multiple similar elements exist
5. Do NOT regenerate the plan -- use the existing plan step instructions

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

        topic_source = f"{session.tutorial_plan.original_query if session and session.tutorial_plan else ''} {completedStepInstruction or ''}"
        topic = _infer_topic_from_message(topic_source)
        if isinstance(highlights, list) and highlights:
            refined, chosen_label = _refine_highlights_to_specific_model(
                highlights,
                dom,
                topic,
                json.dumps(remaining_steps)
            )
            highlights = refined
            if chosen_label:
                print(f'🎯 [/continue-tutorial] refined to specific model target "{chosen_label}"')

        if isinstance(highlights, list) and highlights:
            remaining_instruction_hints: List[str] = []
            remaining_action_hints: List[str] = []
            for step in remaining_steps:
                if isinstance(step, dict):
                    ins = str(step.get("instruction", "")).strip()
                    if ins:
                        remaining_instruction_hints.append(ins)
                        remaining_action_hints.append(str(step.get("actionType", "")).strip().lower())

            control_refined_highlights, _, controls_changed = _refine_highlights_to_control_type(
                highlights,
                dom,
                remaining_instruction_hints,
                remaining_action_hints
            )
            if controls_changed:
                highlights = control_refined_highlights
                print("🎯 [/continue-tutorial] refined highlights by control type (input/button/link)")

        print(f"New page highlights: {len(highlights)}")
        print(f"Page range: {page_range}")
        for i, h in enumerate(highlights):
            print(f"  Highlight {i+1} → elementIndex={h.get('elementIndex', 'none')}, planStep={h.get('planStepNumber', '?')}")
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
    expectedResult: str
    screenshot: Optional[str] = None  # base64 encoded
    dom: Optional[str] = None
    clickedElement: str = ""

class VerifyStepResponse(BaseModel):
    isCorrect: bool
    confidence: float
    reason: str

@app.post("/verify", response_model=VerifyStepResponse)
async def verify_step(request: VerifyStepRequest):
    """
    Verify if a tutorial step was completed correctly.
    Uses fresh screenshot and DOM for better element identification.
    """
    if not api_key:
        return VerifyStepResponse(
            isCorrect=False,
            confidence=0.0,
            reason="API key not configured"
        )

    try:
        # Build verification prompt
        verify_prompt = f"""You are a tutorial verification assistant. Determine if the user correctly completed the following step.

Step Instruction: {request.stepInstruction}
Expected Result: {request.expectedResult}
User clicked on: {request.clickedElement}

Page Context:
{request.dom if request.dom else "(No DOM provided)"}

Based on the screenshot and page context, did the user successfully complete this step? Respond with:
{{
  "isCorrect": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}}"""

        if request.screenshot:
            verify_prompt += "\n(Note: Screenshot provided but omitted; current Cerebras models are text-only.)"

        response = cerebras_chat(
            [{"role": "user", "content": verify_prompt}],
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

        return VerifyStepResponse(
            isCorrect=result.get("isCorrect", False),
            confidence=float(result.get("confidence", 0.5)),
            reason=result.get("reason", "")
        )

    except Exception as e:
        print(f"Verification error: {e}")
        return VerifyStepResponse(
            isCorrect=False,
            confidence=0.0,
            reason=f"Verification failed: {str(e)}"
        )

class DesktopScreenshotResponse(BaseModel):
    screenshot: str  # base64 encoded PNG

@app.get("/capture-desktop", response_model=DesktopScreenshotResponse)
async def capture_desktop():
    """
    Capture a desktop screenshot and return as base64 PNG.
    This is used when a desktop-level capture is needed instead of a tab-only capture.
    """
    try:
        # Capture the entire desktop
        screenshot = ImageGrab.grab()

        # Convert to PNG bytes
        img_byte_arr = io.BytesIO()
        screenshot.save(img_byte_arr, format='PNG')
        img_byte_arr.seek(0)

        # Encode as base64
        img_base64 = base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

        return DesktopScreenshotResponse(screenshot=img_base64)
    except Exception as e:
        print(f"Error capturing desktop: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to capture desktop: {str(e)}")


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
            viewport_height=request.viewport_height
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
            error=result.get("error")
        )

    except Exception as e:
        print(f"❌ VLM detection error: {e}")
        import traceback
        traceback.print_exc()

        return VLMDetectResponse(
            detections=[],
            model_latency_ms=0,
            reasoning=f"VLM detection failed: {str(e)}",
            error=str(e)
        )


@app.get("/vlm-health")
async def vlm_health():
    """
    Check VLM availability and status.

    Returns:
    {
      "vlm_available": true/false,
      "provider": "claude-api",
      "model_name": "claude-3-5-sonnet-20241022",
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
            "model_name": os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
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
