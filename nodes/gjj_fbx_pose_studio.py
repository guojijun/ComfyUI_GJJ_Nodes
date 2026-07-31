from __future__ import annotations

import base64
import json
import math
import os
import re
import struct
import time
import zlib
from array import array
from pathlib import Path
from typing import Any

import folder_paths

NODE_NAME = "GJJ_FBXPoseStudio"
ROUTE_BASE = "/gjj/fbx_pose_studio"


def _comfyui_root() -> Path:
    base_path = getattr(folder_paths, "base_path", None)
    if base_path:
        return Path(base_path)
    current = Path(__file__).resolve()
    for parent in current.parents:
        if parent.name == "custom_nodes":
            return parent.parent
    return current.parents[3]


def _models_root() -> Path:
    models_dir = getattr(folder_paths, "models_dir", None)
    if models_dir:
        return Path(models_dir)
    return _comfyui_root() / "models"


DEFAULT_MODEL_DIR = _models_root() / "GJJ" / "3D"

_FBX_CACHE: dict[str, tuple[float, int, dict[str, Any]]] = {}


def _clean_fbx_name(value: Any) -> str:
    text = str(value or "")
    if "\x00\x01" in text:
        text = text.split("\x00\x01", 1)[0]
    return text.strip() or "Unnamed"


def _prop_tuple(children: list[dict[str, Any]], name: str, fallback: tuple[float, float, float]) -> tuple[float, float, float]:
    for child in children:
        if child.get("name") != "Properties70":
            continue
        for prop in child.get("children", []):
            props = prop.get("props", [])
            if prop.get("name") == "P" and props and props[0] == name and len(props) >= 7:
                try:
                    return (float(props[4]), float(props[5]), float(props[6]))
                except Exception:
                    return fallback
    return fallback


class _BinaryFbxReader:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        if not self.data.startswith(b"Kaydara FBX Binary"):
            raise ValueError("只支持二进制 FBX 文件。")
        self.version = struct.unpack_from("<I", self.data, 23)[0]
        self.wide = self.version >= 7500

    def parse(self) -> list[dict[str, Any]]:
        pos = 27
        nodes: list[dict[str, Any]] = []
        while pos < len(self.data):
            node, pos = self._read_node(pos)
            if node is None:
                break
            nodes.append(node)
        return nodes

    def _read_node(self, pos: int):
        if self.wide:
            end, prop_count, _prop_len = struct.unpack_from("<QQQ", self.data, pos)
            pos += 24
        else:
            end, prop_count, _prop_len = struct.unpack_from("<III", self.data, pos)
            pos += 12
        name_len = self.data[pos]
        pos += 1
        if end == 0 and prop_count == 0 and name_len == 0:
            return None, pos
        name = self.data[pos:pos + name_len].decode("utf-8", "replace")
        pos += name_len
        props = []
        for _ in range(prop_count):
            value, pos = self._read_prop(pos)
            props.append(value)
        children = []
        while pos < end:
            child, new_pos = self._read_node(pos)
            pos = new_pos
            if child is None:
                break
            children.append(child)
        return {"name": name, "props": props, "children": children}, pos

    def _read_prop(self, pos: int):
        tag = chr(self.data[pos])
        pos += 1
        if tag == "C":
            return bool(self.data[pos]), pos + 1
        if tag == "Y":
            return struct.unpack_from("<h", self.data, pos)[0], pos + 2
        if tag == "I":
            return struct.unpack_from("<i", self.data, pos)[0], pos + 4
        if tag == "L":
            return struct.unpack_from("<q", self.data, pos)[0], pos + 8
        if tag == "F":
            return struct.unpack_from("<f", self.data, pos)[0], pos + 4
        if tag == "D":
            return struct.unpack_from("<d", self.data, pos)[0], pos + 8
        if tag in {"S", "R"}:
            length = struct.unpack_from("<I", self.data, pos)[0]
            pos += 4
            raw = self.data[pos:pos + length]
            pos += length
            if tag == "R":
                return raw, pos
            return raw.decode("utf-8", "replace"), pos
        if tag in {"f", "d", "i", "l", "b"}:
            count, encoding, comp_len = struct.unpack_from("<III", self.data, pos)
            pos += 12
            raw = self.data[pos:pos + comp_len]
            pos += comp_len
            if encoding:
                raw = zlib.decompress(raw)
            typecode = {"f": "f", "d": "d", "i": "i", "l": "q", "b": "b"}[tag]
            arr = array(typecode)
            arr.frombytes(raw)
            if struct.pack("=H", 1) != struct.pack("<H", 1):
                arr.byteswap()
            return list(arr[:count]), pos
        raise ValueError(f"未知 FBX 属性类型：{tag}")


def _find_top(nodes: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    return next((node for node in nodes if node.get("name") == name), None)


def _child(node: dict[str, Any], name: str):
    return next((item for item in node.get("children", []) if item.get("name") == name), None)


def _first_array(node: dict[str, Any], name: str) -> list[Any]:
    child = _child(node, name)
    if child and child.get("props") and isinstance(child["props"][0], list):
        return child["props"][0]
    return []


def _build_fbx_payload(path: Path) -> dict[str, Any]:
    stat = path.stat()
    cache_key = str(path.resolve()).lower()
    cached = _FBX_CACHE.get(cache_key)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]

    root = _BinaryFbxReader(path).parse()
    objects = _find_top(root, "Objects") or {"children": []}
    connections = _find_top(root, "Connections") or {"children": []}

    geometries: dict[int, dict[str, Any]] = {}
    models: dict[int, dict[str, Any]] = {}
    skins: set[int] = set()
    clusters: dict[int, dict[str, Any]] = {}
    conns: list[tuple[str, int, int, str]] = []

    for item in objects.get("children", []):
        props = item.get("props", [])
        if not props:
            continue
        name = item.get("name")
        obj_id = int(props[0])
        obj_name = _clean_fbx_name(props[1] if len(props) > 1 else "")
        obj_type = str(props[2] if len(props) > 2 else "")
        if name == "Geometry" and obj_type == "Mesh":
            geometries[obj_id] = {
                "id": obj_id,
                "name": obj_name,
                "vertices": _first_array(item, "Vertices"),
                "polygon_indices": _first_array(item, "PolygonVertexIndex"),
            }
        elif name == "Model":
            models[obj_id] = {
                "id": obj_id,
                "name": obj_name,
                "type": obj_type,
                "t": _prop_tuple(item.get("children", []), "Lcl Translation", (0.0, 0.0, 0.0)),
                "r": _prop_tuple(item.get("children", []), "Lcl Rotation", (0.0, 0.0, 0.0)),
                "s": _prop_tuple(item.get("children", []), "Lcl Scaling", (1.0, 1.0, 1.0)),
            }
        elif name == "Deformer" and obj_type == "Skin":
            skins.add(obj_id)
        elif name == "Deformer" and obj_type == "Cluster":
            clusters[obj_id] = {
                "id": obj_id,
                "indexes": _first_array(item, "Indexes"),
                "weights": _first_array(item, "Weights"),
            }

    for item in connections.get("children", []):
        props = item.get("props", [])
        if item.get("name") == "C" and len(props) >= 3:
            conns.append((str(props[0]), int(props[1]), int(props[2]), str(props[3]) if len(props) > 3 else ""))

    geom_to_model: dict[int, int] = {}
    skin_to_geom: dict[int, int] = {}
    cluster_to_skin: dict[int, int] = {}
    cluster_to_bone: dict[int, int] = {}
    bone_parent: dict[int, int] = {}
    for kind, child_id, parent_id, _prop in conns:
        if kind != "OO":
            continue
        if child_id in geometries and parent_id in models:
            geom_to_model[child_id] = parent_id
        elif child_id in skins and parent_id in geometries:
            skin_to_geom[child_id] = parent_id
        elif child_id in clusters and parent_id in skins:
            cluster_to_skin[child_id] = parent_id
        elif child_id in models and parent_id in clusters:
            cluster_to_bone[parent_id] = child_id
        elif child_id in models and parent_id in models:
            bone_parent[child_id] = parent_id

    used_bone_ids = [model_id for model_id, model in models.items() if model.get("type") == "LimbNode"]
    bone_index = {bone_id: idx for idx, bone_id in enumerate(used_bone_ids)}
    bones = []
    for bone_id in used_bone_ids:
        model = models[bone_id]
        parent_id = bone_parent.get(bone_id)
        bones.append({
            "id": bone_id,
            "name": model["name"],
            "parent": bone_index.get(parent_id, -1),
            "t": [round(float(v), 6) for v in model["t"]],
            "r": [round(float(v), 6) for v in model["r"]],
            "s": [round(float(v), 6) for v in model["s"]],
        })

    weights_by_geom: dict[int, dict[int, list[tuple[int, float]]]] = {}
    for cluster_id, skin_id in cluster_to_skin.items():
        geom_id = skin_to_geom.get(skin_id)
        bone_id = cluster_to_bone.get(cluster_id)
        if geom_id is None or bone_id not in bone_index:
            continue
        bone_idx = bone_index[bone_id]
        target = weights_by_geom.setdefault(geom_id, {})
        cluster = clusters[cluster_id]
        for vertex_idx, weight in zip(cluster.get("indexes", []), cluster.get("weights", [])):
            target.setdefault(int(vertex_idx), []).append((bone_idx, float(weight)))

    meshes = []
    for geom_id, geom in geometries.items():
        vertices = geom.get("vertices") or []
        poly = geom.get("polygon_indices") or []
        if not vertices or not poly:
            continue
        control = [(float(vertices[i]), float(vertices[i + 1]), float(vertices[i + 2])) for i in range(0, len(vertices), 3)]
        faces: list[list[int]] = []
        face: list[int] = []
        for raw in poly:
            idx = int(raw)
            if idx < 0:
                face.append(-idx - 1)
                if len(face) >= 3:
                    faces.append(face)
                face = []
            else:
                face.append(idx)
        if len(face) >= 3:
            faces.append(face)

        pos: list[float] = []
        normals: list[float] = []
        skin_i: list[int] = []
        skin_w: list[float] = []
        geom_weights = weights_by_geom.get(geom_id, {})

        def add_vertex(cp_idx: int, normal: tuple[float, float, float]):
            x, y, z = control[cp_idx]
            pos.extend((x, y, z))
            normals.extend(normal)
            pairs = sorted(geom_weights.get(cp_idx, []), key=lambda item: item[1], reverse=True)[:4]
            total = sum(weight for _bone, weight in pairs) or 1.0
            while len(pairs) < 4:
                pairs.append((0, 0.0))
            skin_i.extend(int(bone) for bone, _weight in pairs)
            skin_w.extend(float(weight) / total for _bone, weight in pairs)

        for face in faces:
            for tri in range(1, len(face) - 1):
                ids = [face[0], face[tri], face[tri + 1]]
                a, b, c = [control[i] for i in ids]
                ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
                vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
                nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
                length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                normal = (nx / length, ny / length, nz / length)
                for cp in ids:
                    add_vertex(cp, normal)

        if pos:
            mesh_model = models.get(geom_to_model.get(geom_id, 0), {})
            meshes.append({
                "id": geom_id,
                "name": mesh_model.get("name") or geom.get("name") or "Mesh",
                "positions": [round(v, 6) for v in pos],
                "normals": [round(v, 6) for v in normals],
                "skinIndices": skin_i,
                "skinWeights": [round(v, 6) for v in skin_w],
            })

    payload = {
        "ok": True,
        "path": str(path),
        "name": path.name,
        "version": _BinaryFbxReader(path).version,
        "meshes": meshes,
        "bones": bones,
        "created": time.time(),
    }
    _FBX_CACHE[cache_key] = (stat.st_mtime, stat.st_size, payload)
    return payload


def _resolve_fbx_path(value: str) -> Path:
    raw = str(value or "").strip().strip('"')
    if not raw:
        raise ValueError("缺少 FBX 路径。")
    path = Path(os.path.expandvars(os.path.expanduser(raw)))
    if not path.is_absolute():
        path = DEFAULT_MODEL_DIR / path
    path = path.resolve()
    if path.suffix.lower() != ".fbx":
        raise ValueError("只能载入 .fbx 文件。")
    if not path.is_file():
        raise FileNotFoundError(f"FBX 文件不存在：{path}")
    return path


def _list_default_fbx() -> list[dict[str, Any]]:
    if not DEFAULT_MODEL_DIR.is_dir():
        return []
    items = []
    for path in sorted(DEFAULT_MODEL_DIR.glob("*.fbx")):
        try:
            stat = path.stat()
            items.append({"name": path.name, "path": str(path), "size": stat.st_size})
        except Exception:
            pass
    return items


def _register_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:
        print(f"[GJJ FBX Pose Studio] 跳过接口注册：{exc}")
        return

    server = PromptServer.instance
    if getattr(server, "_gjj_fbx_pose_studio_routes_registered", False):
        return

    @server.routes.get(f"{ROUTE_BASE}/list")
    async def list_fbx(_request):
        return web.json_response({"ok": True, "directory": str(DEFAULT_MODEL_DIR), "files": _list_default_fbx()})

    @server.routes.get(f"{ROUTE_BASE}/model")
    async def get_model(request):
        try:
            path = _resolve_fbx_path(request.query.get("path", ""))
            return web.json_response(_build_fbx_payload(path))
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    setattr(server, "_gjj_fbx_pose_studio_routes_registered", True)


_register_routes()


def _decode_image_data(image_data: str, width: int, height: int):
    import io

    import numpy as np
    import torch
    from PIL import Image

    text = str(image_data or "").strip()
    if "," in text and text.startswith("data:"):
        text = text.split(",", 1)[1]
    if not text:
        return torch.zeros((1, height, width, 3), dtype=torch.float32)
    raw = base64.b64decode(re.sub(r"\s+", "", text))
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    if image.size != (width, height):
        image = image.resize((width, height), Image.LANCZOS)
    arr = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


class GJJ_FBXPoseStudio:
    CATEGORY = "GJJ/三维"
    FUNCTION = "execute"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图片", "姿势JSON")
    DESCRIPTION = "GJJ 零依赖 FBX 姿势工作室：直接载入本地绑定骨骼 FBX，在节点面板中调整骨骼、位置、相机，并输出当前截图。"
    SEARCH_ALIASES = ["FBX", "3D", "pose", "骨骼", "姿势", "GJJ 3D"]

    @classmethod
    def INPUT_TYPES(cls):
        files = _list_default_fbx()
        default_path = str(DEFAULT_MODEL_DIR / "X_Bot.fbx")
        for item in files:
            if str(item.get("name", "")).lower() == "x_bot.fbx":
                default_path = item["path"]
                break
        if not Path(default_path).is_file() and files:
            default_path = files[0]["path"]
        return {
            "required": {},
            "optional": {
                "fbx_path": ("STRING", {"default": default_path, "multiline": False, "display_name": "FBX路径"}),
                "width": ("INT", {"default": 1024, "min": 128, "max": 4096, "step": 64, "display_name": "宽度"}),
                "height": ("INT", {"default": 1024, "min": 128, "max": 4096, "step": 64, "display_name": "高度"}),
            },
            "hidden": {
                "image_data": "STRING",
                "pose_json": "STRING",
                "unique_id": "UNIQUE_ID",
            },
        }

    def execute(self, fbx_path="", width=1024, height=1024, image_data="", pose_json="", unique_id=None):
        width = max(128, min(4096, int(width or 1024)))
        height = max(128, min(4096, int(height or 1024)))
        image = _decode_image_data(image_data, width, height)
        pose_text = str(pose_json or "{}")
        try:
            parsed = json.loads(pose_text)
            if isinstance(parsed, dict):
                parsed.setdefault("fbx_path", str(fbx_path or ""))
                pose_text = json.dumps(parsed, ensure_ascii=False)
        except Exception:
            pose_text = json.dumps({"fbx_path": str(fbx_path or ""), "raw": pose_text}, ensure_ascii=False)
        return (image, pose_text)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_FBXPoseStudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "FBX姿势工作室（零依赖）",
}
