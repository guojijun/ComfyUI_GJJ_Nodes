# GJJ 本地工具模块目录。

from .tsv_translation import (
    DEFAULT_TRANSLATION_TSV,
    TRANSLATION_ROOT,
    TranslationTable,
    load_translation_table,
    translate_term,
    translate_text_by_terms,
    translate_text_to_chinese,
    translate_text_to_english,
    translate_to_chinese,
    translate_to_english,
)

__all__ = [
    "DEFAULT_TRANSLATION_TSV",
    "TRANSLATION_ROOT",
    "TranslationTable",
    "load_translation_table",
    "translate_term",
    "translate_text_by_terms",
    "translate_text_to_chinese",
    "translate_text_to_english",
    "translate_to_chinese",
    "translate_to_english",
]
