from __future__ import annotations

import json
import os
import re
import sys
import traceback
from typing import Any

try:
    from aiohttp import web
    from server import PromptServer
    HAS_SERVER = True
except Exception:
    web = None
    PromptServer = None
    HAS_SERVER = False

NODE_NAME = "GJJ_NodeLocator"
API_PATH = "/gjj/node_locator/search"


def _build_match_score(node_type: str, node_title: str, node_id: str, keyword: str) -> int:
    """计算节点与关键词的匹配得分，用于排序。"""
    kw_lower = keyword.lower()
    type_lower = node_type.lower()
    title_lower = node_title.lower()
    id_str = str(node_id).lower()

    score = 0
    if kw_lower == type_lower:
        score += 100
    elif type_lower.startswith(kw_lower):
        score += 80
    elif kw_lower in type_lower:
        score += 60
    if kw_lower == title_lower:
        score += 50
    elif title_lower.startswith(kw_lower):
        score += 40
    elif kw_lower in title_lower:
        score += 20
    if id_str == kw_lower:
        score += 30
    elif kw_lower in id_str:
        score += 10
    return score


def _fuzzy_match(text: str, keyword: str) -> bool:
    """模糊匹配：检查关键词是否在文本中。"""
    if not text or not keyword:
        return False
    return keyword.lower() in text.lower()


def search_workflow_nodes(keyword: str, extra_pnginfo: Any = None, unique_id: Any = None) -> list[dict[str, Any]]:
    """搜索工作流中匹配关键词的节点。"""
    results: list[dict[str, Any]] = []

    if not isinstance(extra_pnginfo, dict):
        return results

    workflow = extra_pnginfo.get("workflow")
    if not isinstance(workflow, dict):
        return results

    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return results

    kw = str(keyword or "").strip()
    if not kw:
        return results

    for node in nodes:
        if not isinstance(node, dict):
            continue

        node_id = node.get("id")
        node_type = str(node.get("type") or "")
        node_title = str(node.get("title") or node.get("name") or "")

        score = _build_match_score(node_type, node_title, node_id, kw)
        if score <= 0:
            continue

        properties = node.get("properties") or {}
        widgets_values = node.get("widgets_values") or []

        results.append({
            "id": str(node_id),
            "type": node_type,
            "title": node_title,
            "score": score,
            "has_error": bool(node.get("properties", {}).get("GJJ_ERROR")),
        })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:20]


async def handle_node_locator_search(request):
    """处理节点搜索API请求。"""
    try:
        data = await request.json()
        keyword = data.get("keyword", "")
        extra_pnginfo = data.get("extra_pnginfo")
        unique_id = data.get("unique_id")

        results = search_workflow_nodes(keyword, extra_pnginfo, unique_id)

        return web.json_response({
            "success": True,
            "results": results,
            "keyword": keyword,
        })
    except Exception as e:
        return web.json_response({
            "success": False,
            "error": str(e),
            "results": [],
        }, status=500)


if HAS_SERVER and PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    PromptServer.instance.routes.get(API_PATH)(handle_node_locator_search)


class GJJ_NodeLocator:
    CATEGORY = "GJJ/工作流辅助"
    FUNCTION = "noop"
    OUTPUT_NODE = True
    DESCRIPTION = "通过搜索关键词快速定位当前工作流中的指定节点并框选。支持节点类型、标题、ID搜索。"
    SEARCH_ALIASES = ["node locator", "node search", "find node", "搜索节点", "定位节点", "节点搜索"]

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_TOOLTIPS = ()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "keyword": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "🔍 搜索关键词",
                        "tooltip": "输入节点类型、标题或ID关键词进行搜索。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(cls, keyword="", **kwargs):
        return str(keyword or "")

    def noop(self, keyword="", unique_id=None, extra_pnginfo=None):
        if keyword and extra_pnginfo and unique_id and PromptServer:
            try:
                results = search_workflow_nodes(keyword, extra_pnginfo, unique_id)
                PromptServer.instance.send_sync("gjj_node_locator_results", {
                    "node": unique_id,
                    "keyword": keyword,
                    "results": results,
                })
            except Exception:
                pass
        return ()


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_NodeLocator}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🔍 节点定位搜索"}
