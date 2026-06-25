from __future__ import annotations


def normalize_lora_trigger_text(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parts = []
    seen = set()
    for part in text.replace("\n", ",").split(","):
        item = " ".join(str(part or "").strip().split())
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            parts.append(item)
    return ", ".join(parts)


def append_lora_triggers_to_positive_prompt(prompt, lora_triggers) -> str:
    prompt_text = str(prompt or "").strip()
    trigger_text = normalize_lora_trigger_text(lora_triggers)
    if not trigger_text:
        return prompt_text
    if trigger_text.lower() in prompt_text.lower():
        return prompt_text
    return f"{prompt_text}, {trigger_text}" if prompt_text else trigger_text
