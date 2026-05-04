from __future__ import annotations

import os
from typing import Iterable


MODEL_EXTENSIONS = (
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".gguf",
    ".onnx",
)


def model_basename(name: str) -> str:
    return str(name or "").replace("\\", "/").split("/")[-1]


def model_stem(name: str) -> str:
    base = model_basename(name)
    lower_base = base.lower()
    for ext in MODEL_EXTENSIONS:
        if lower_base.endswith(ext):
            return base[: -len(ext)]
    return os.path.splitext(base)[0]


def normalize_lookup_text(text: str) -> str:
    return "".join(ch for ch in str(text or "").casefold() if ch.isalnum())


def longest_common_substring_length(left: str, right: str) -> int:
    left_norm = normalize_lookup_text(left)
    right_norm = normalize_lookup_text(right)
    if not left_norm or not right_norm:
        return 0

    previous = [0] * (len(right_norm) + 1)
    best = 0
    for left_index, left_char in enumerate(left_norm, start=1):
        current = [0] * (len(right_norm) + 1)
        for right_index, right_char in enumerate(right_norm, start=1):
            if left_char == right_char:
                value = previous[right_index - 1] + 1
                current[right_index] = value
                if value > best:
                    best = value
        previous = current
    return best


def _minimum_common_length(preferred_stem: str) -> int:
    normalized_length = len(normalize_lookup_text(preferred_stem))
    if normalized_length <= 8:
        return max(4, normalized_length)
    return max(8, min(16, normalized_length // 3))


def _subdir_score(preferred: str, candidate: str) -> int:
    preferred_parts = str(preferred or "").replace("\\", "/").casefold().split("/")
    candidate_parts = str(candidate or "").replace("\\", "/").casefold().split("/")
    if len(preferred_parts) <= 1 or len(candidate_parts) <= 1:
        return 0
    return 50 if preferred_parts[0] == candidate_parts[0] else 0


def _candidate_score(preferred: str, candidate: str) -> int:
    preferred_stem = model_stem(preferred)
    candidate_stem = model_stem(candidate)
    preferred_norm = normalize_lookup_text(preferred_stem)
    candidate_norm = normalize_lookup_text(candidate_stem)
    if not preferred_norm or not candidate_norm:
        return 0

    score = _subdir_score(preferred, candidate)
    if preferred_norm == candidate_norm:
        return 1_000_000 + score + len(preferred_norm)
    if preferred_norm in candidate_norm:
        return 900_000 + score + len(preferred_norm)
    if candidate_norm in preferred_norm:
        return 800_000 + score + len(candidate_norm)

    common_len = longest_common_substring_length(preferred_stem, candidate_stem)
    if common_len < _minimum_common_length(preferred_stem):
        return 0
    return score + common_len


def pick_available_model_name(
    preferred: str,
    available: Iterable[str],
    fallback: str = "",
    *,
    allow_first: bool = False,
) -> str:
    preferred = str(preferred or "").strip()
    fallback = str(fallback or "").strip()
    names = list(available or [])
    if not names:
        return ""

    if preferred and preferred in names:
        return preferred

    preferred_base = model_basename(preferred).casefold()
    if preferred_base:
        for name in names:
            if model_basename(name).casefold() == preferred_base:
                return name

    if preferred:
        scored = [(_candidate_score(preferred, name), index, name) for index, name in enumerate(names)]
        scored = [item for item in scored if item[0] > 0]
        if scored:
            scored.sort(key=lambda item: (-item[0], item[1]))
            return scored[0][2]

    if fallback and fallback != preferred:
        resolved = pick_available_model_name(fallback, names, "", allow_first=False)
        if resolved:
            return resolved

    return names[0] if allow_first else ""
