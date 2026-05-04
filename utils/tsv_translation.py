from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re
from typing import Iterable


TRANSLATION_ROOT = Path(__file__).resolve().parent.parent / "presets" / "translations"
DEFAULT_TRANSLATION_TSV = TRANSLATION_ROOT / "zh_en.tsv"


def normalize_translation_text(value: object) -> str:
    return str(value or "").strip()


def normalize_translation_key(value: object) -> str:
    text = normalize_translation_text(value).lower()
    return re.sub(r"[\s,，;；|/\\:_\-]+", "", text)


@dataclass(frozen=True)
class TranslationTable:
    pairs: tuple[tuple[str, str], ...]
    zh_to_en: dict[str, str]
    en_to_zh: dict[str, str]
    normalized_zh_to_en: dict[str, str]
    normalized_en_to_zh: dict[str, str]
    zh_to_en_terms: tuple[tuple[str, str], ...]
    en_to_zh_terms: tuple[tuple[str, str], ...]


def _iter_tsv_pairs(path: Path) -> Iterable[tuple[str, str]]:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        columns = raw_line.split("\t")
        if len(columns) < 2:
            continue
        zh = normalize_translation_text(columns[0])
        en = normalize_translation_text(columns[1])
        if zh and en:
            yield zh, en


def _make_lookup(pairs: list[tuple[str, str]], source_index: int, target_index: int) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for pair in pairs:
        source = pair[source_index]
        target = pair[target_index]
        if source and target and source not in lookup:
            lookup[source] = target
    return lookup


def _make_normalized_lookup(pairs: list[tuple[str, str]], source_index: int, target_index: int) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for pair in pairs:
        key = normalize_translation_key(pair[source_index])
        target = pair[target_index]
        if key and target and key not in lookup:
            lookup[key] = target
    return lookup


def _dedupe_pairs(pairs: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for zh, en in pairs:
        zh_text = normalize_translation_text(zh)
        en_text = normalize_translation_text(en)
        key = (normalize_translation_key(zh_text), normalize_translation_key(en_text))
        if not zh_text or not en_text or key in seen:
            continue
        seen.add(key)
        result.append((zh_text, en_text))
    return result


def _make_term_list(pairs: list[tuple[str, str]], source_index: int, target_index: int) -> tuple[tuple[str, str], ...]:
    terms: list[tuple[str, str]] = []
    seen: set[str] = set()
    for pair in pairs:
        source = pair[source_index]
        target = pair[target_index]
        key = normalize_translation_key(source)
        if not source or not target or not key or key in seen:
            continue
        seen.add(key)
        terms.append((source, target))
    terms.sort(key=lambda item: (len(item[0]), item[0].lower()), reverse=True)
    return tuple(terms)


@lru_cache(maxsize=16)
def load_translation_table(path: str | None = None) -> TranslationTable:
    file_path = Path(path) if path else DEFAULT_TRANSLATION_TSV
    pairs = _dedupe_pairs(_iter_tsv_pairs(file_path))
    return TranslationTable(
        pairs=tuple(pairs),
        zh_to_en=_make_lookup(pairs, 0, 1),
        en_to_zh=_make_lookup(pairs, 1, 0),
        normalized_zh_to_en=_make_normalized_lookup(pairs, 0, 1),
        normalized_en_to_zh=_make_normalized_lookup(pairs, 1, 0),
        zh_to_en_terms=_make_term_list(pairs, 0, 1),
        en_to_zh_terms=_make_term_list(pairs, 1, 0),
    )


def translate_term(
    text: object,
    target_language: str = "zh",
    default: str | None = None,
    path: str | None = None,
    normalized: bool = True,
) -> str:
    source = normalize_translation_text(text)
    if not source:
        return default if default is not None else ""

    table = load_translation_table(path)
    target = normalize_translation_text(target_language).lower()
    if target in {"zh", "cn", "chinese", "中文"}:
        exact = table.en_to_zh.get(source)
        fuzzy = table.normalized_en_to_zh.get(normalize_translation_key(source)) if normalized else None
    elif target in {"en", "english", "英文"}:
        exact = table.zh_to_en.get(source)
        fuzzy = table.normalized_zh_to_en.get(normalize_translation_key(source)) if normalized else None
    else:
        raise ValueError(f"不支持的目标语言: {target_language}")

    return exact or fuzzy or (default if default is not None else source)


def translate_to_chinese(text: object, default: str | None = None, path: str | None = None) -> str:
    return translate_term(text, target_language="zh", default=default, path=path)


def translate_to_english(text: object, default: str | None = None, path: str | None = None) -> str:
    return translate_term(text, target_language="en", default=default, path=path)


def _is_ascii_term(term: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _'’.,:+()\\/-]*", term))


def _has_ascii_boundary(text: str, start: int, end: int) -> bool:
    before = text[start - 1] if start > 0 else ""
    after = text[end] if end < len(text) else ""
    return not (before and re.match(r"[A-Za-z0-9_]", before)) and not (after and re.match(r"[A-Za-z0-9_]", after))


def translate_text_by_terms(text: object, target_language: str = "zh", path: str | None = None) -> str:
    source_text = normalize_translation_text(text)
    if not source_text:
        return ""

    table = load_translation_table(path)
    target = normalize_translation_text(target_language).lower()
    if target in {"zh", "cn", "chinese", "中文"}:
        terms = table.en_to_zh_terms
    elif target in {"en", "english", "英文"}:
        terms = table.zh_to_en_terms
    else:
        raise ValueError(f"不支持的目标语言: {target_language}")

    if not terms:
        return source_text

    lower_source = source_text.lower()
    output: list[str] = []
    position = 0
    while position < len(source_text):
        matched: tuple[str, str] | None = None
        for term, replacement in terms:
            end = position + len(term)
            if lower_source[position:end] != term.lower():
                continue
            if _is_ascii_term(term) and not _has_ascii_boundary(source_text, position, end):
                continue
            matched = (term, replacement)
            break

        if matched:
            term, replacement = matched
            output.append(replacement)
            position += len(term)
        else:
            output.append(source_text[position])
            position += 1

    return "".join(output)


def translate_text_to_chinese(text: object, path: str | None = None) -> str:
    return translate_text_by_terms(text, target_language="zh", path=path)


def translate_text_to_english(text: object, path: str | None = None) -> str:
    return translate_text_by_terms(text, target_language="en", path=path)


__all__ = [
    "DEFAULT_TRANSLATION_TSV",
    "TRANSLATION_ROOT",
    "TranslationTable",
    "load_translation_table",
    "normalize_translation_key",
    "normalize_translation_text",
    "translate_term",
    "translate_text_by_terms",
    "translate_text_to_chinese",
    "translate_text_to_english",
    "translate_to_chinese",
    "translate_to_english",
]
