from __future__ import annotations

import json
from typing import Any

NODE_NAME = "GJJ_LTX_FirstLastFrame"
WEB_DIRECTORY = "./web"
MAX_DYNAMIC_IMAGES = 64


class AnyType(str):
    """ComfyUI 任意类型占位，允许前端动态输入接入 IMAGE。"""

    def __ne__(self, __value: object) -> bool:  # noqa: D105
        return False


any_type = AnyType("*")


class FlexibleOptionalInputType(dict):
    """允许 JS 前端动态创建 image_02 / image_03 ... 输入口。

    注意：前端显示的动态参考图全部按 image_xx 命名。
    这里对 image_xx 明确返回 IMAGE，而不是 *，避免前端出现 UNKNOWN/空插槽。
    """

    def __init__(self, data: dict[str, Any] | None = None):
        super().__init__()
        self.data = data or {}
        for key, value in self.data.items():
            self[key] = value

    def __getitem__(self, key: str):
        if key in self.data:
            return self.data[key]
        if str(key).startswith("image_"):
            return ("IMAGE", {"forceInput": True})
        return (any_type, {"forceInput": True})

    def __contains__(self, key: object) -> bool:
        # 让后端接受 JS 动态创建的 image_02 / image_03 ...
        return True


def _runtime_import_ltx_tools():
    """运行时加载 LTX 依赖，避免 ComfyUI 启动阶段因为依赖缺失导致扩展失败。"""
    try:
        from comfy_extras.nodes_lt import LTXVAddGuide, get_noise_mask

        return LTXVAddGuide, get_noise_mask, None
    except Exception as exc:  # pragma: no cover - 依赖由 ComfyUI 环境提供
        return None, None, exc


def _runtime_import_torch():
    """运行时加载 torch，避免模块 import 阶段硬依赖。"""
    try:
        import torch

        return torch, None
    except Exception as exc:  # pragma: no cover
        return None, exc


class GJJ_LTX_FirstLastFrame:
    CATEGORY = "GJJ/视频"
    FUNCTION = "execute"
    DESCRIPTION = (
        "LTX 多参考帧引导。参考图输入由前端动态扩充，num_images 不显示；"
        "作用帧和强度使用紧凑中文界面配置；正/反条件可不接；错误打印后透传继续。"
    )
    SEARCH_ALIASES = [
        "ltx first last",
        "ltx first frame",
        "ltx last frame",
        "ltx guide multi",
        "LTX 多图参考",
        "LTX 首尾帧",
        "首尾帧",
        "多帧引导",
    ]

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "反向条件", "视频潜空间")
    OUTPUT_TOOLTIPS = (
        "已追加参考帧引导信息的正向条件；未接时返回 None。",
        "已追加参考帧引导信息的反向条件；未接时返回 None。",
        "写入参考帧 latent 和噪声遮罩后的视频潜空间；失败时透传原 latent。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        optional = FlexibleOptionalInputType(
            {
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正向条件（可选）",
                        "tooltip": "可不连接。连接后会追加 LTX 参考帧 guide 信息；未连接则只写入视频潜空间。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "反向条件（可选）",
                        "tooltip": "可不连接。连接后会尽量同步追加 guide 信息；未连接则忽略。",
                    },
                ),
                "image_01": (
                    "IMAGE",
                    {
                        "forceInput": True,
                        "display_name": "🖼️ 01",
                        "tooltip": "参考图 1。连接图片后自动增加下一个参考图输入。",
                    },
                ),
            },
        )
        return {
            "required": {
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE 解码器",
                        "tooltip": "用于把参考图片编码为 LTX 引导潜空间。",
                    },
                ),
                "latent": (
                    "LATENT",
                    {
                        "display_name": "视频潜空间",
                        "tooltip": "接 EmptyLTXVLatentVideo 或上游视频 latent；输出会保留原始附加字段。",
                    },
                ),
            },
            "optional": optional,
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @staticmethod
    def _log(message: str) -> None:
        print(f"[GJJ_LTX_FirstLastFrame] {message}")

    @staticmethod
    def _warn(message: str) -> None:
        print(f"[GJJ_LTX_FirstLastFrame][警告] {message}")

    @staticmethod
    def _is_tensor(value: Any) -> bool:
        torch, _ = _runtime_import_torch()
        return torch is not None and isinstance(value, torch.Tensor)

    @classmethod
    def _is_empty_loader_placeholder(cls, value: Any) -> bool:
        if not cls._is_tensor(value) or getattr(value, "ndim", None) != 4:
            return False
        try:
            if (
                int(value.shape[0]) != 1
                or int(value.shape[1]) != 64
                or int(value.shape[2]) != 64
            ):
                return False
            return float(value.detach().abs().amax().item()) <= 1e-7
        except Exception:
            return False

    @classmethod
    def _is_valid_image(cls, value: Any) -> bool:
        if not cls._is_tensor(value) or getattr(value, "ndim", None) != 4:
            return False
        if cls._is_empty_loader_placeholder(value):
            return False
        try:
            return (
                int(value.shape[0]) > 0
                and int(value.shape[1]) > 0
                and int(value.shape[2]) > 0
            )
        except Exception:
            return False

    @classmethod
    def _is_non_black_image(cls, value: Any) -> bool:
        if not cls._is_valid_image(value):
            return False
        try:
            return float(value.detach().abs().amax().item()) > 0.001
        except Exception:
            return True

    @staticmethod
    def _clone_latent_or_passthrough(latent: Any) -> Any:
        torch, _ = _runtime_import_torch()
        if not isinstance(latent, dict) or "samples" not in latent:
            return latent
        samples = latent.get("samples")
        if torch is None or not isinstance(samples, torch.Tensor):
            return latent.copy()
        cloned = {"samples": samples.clone()}
        for key, value in latent.items():
            if key == "samples":
                continue
            if key == "noise_mask" and isinstance(value, torch.Tensor):
                cloned[key] = value.clone()
            else:
                cloned[key] = value
        return cloned

    @staticmethod
    def _unpack_node_output(node_output: Any) -> tuple[Any, ...]:
        if hasattr(node_output, "result"):
            node_output = node_output.result
        if isinstance(node_output, tuple):
            return node_output
        if isinstance(node_output, list):
            return tuple(node_output)
        return (node_output,)

    @staticmethod
    def _parse_number_list(value: Any, cast, default: list[Any]) -> list[Any]:
        if value is None:
            return list(default)
        if isinstance(value, (int, float)):
            try:
                return [cast(value)]
            except Exception:
                return list(default)
        text = str(value).strip()
        if not text:
            return list(default)
        for sep in ["，", "；", ";", "|", "\n", "\t"]:
            text = text.replace(sep, ",")
        parts: list[str] = []
        for chunk in text.split(","):
            chunk = chunk.strip()
            if chunk:
                parts.extend([p for p in chunk.split(" ") if p.strip()])
        out = []
        for part in parts:
            try:
                out.append(cast(part))
            except Exception:
                continue
        return out or list(default)

    @staticmethod
    def _expand_list(values: list[Any], count: int, fallback: Any) -> list[Any]:
        if count <= 0:
            return []
        if not values:
            values = [fallback]
        out = list(values[:count])
        while len(out) < count:
            out.append(out[-1])
        return out

    @staticmethod
    def _latent_pixel_frame_count(latent: Any) -> int:
        try:
            latent_length = int(latent["samples"].shape[2])
            return max(1, (latent_length - 1) * 8 + 1)
        except Exception:
            return 1

    @classmethod
    def _auto_frame_indices(cls, count: int, latent: Any) -> list[int]:
        if count <= 0:
            return []
        if count == 1:
            return [0]
        if count == 2:
            return [0, -1]
        pixel_frames = cls._latent_pixel_frame_count(latent)
        last_pixel = max(0, pixel_frames - 1)
        values: list[int] = []
        for idx in range(count):
            if idx == 0:
                values.append(0)
            elif idx == count - 1:
                values.append(-1)
            else:
                values.append(int(round(last_pixel * idx / (count - 1))))
        return values

    @staticmethod
    def _parse_config_json(value: Any) -> list[dict[str, Any]]:
        if value is None:
            return []
        try:
            parsed = json.loads(str(value))
        except Exception:
            return []
        if not isinstance(parsed, list):
            return []
        out = []
        for item in parsed:
            if isinstance(item, dict):
                out.append(item)
        return out

    @classmethod
    def _config_from_workflow_properties(
        cls, extra_pnginfo: Any, unique_id: Any
    ) -> list[dict[str, Any]]:
        """从工作流节点 properties 读取前端保存的配置，避免创建隐藏 widget 造成空行。"""
        if not isinstance(extra_pnginfo, dict) or unique_id is None:
            return []
        workflow = extra_pnginfo.get("workflow")
        if not isinstance(workflow, dict):
            return []
        nodes = workflow.get("nodes")
        if not isinstance(nodes, list):
            return []
        uid_text = str(unique_id)
        for node in nodes:
            if not isinstance(node, dict) or str(node.get("id")) != uid_text:
                continue
            props = node.get("properties")
            if not isinstance(props, dict):
                return []
            return cls._parse_config_json(
                props.get("guide_config_json") or props.get("gjj_guide_config") or "[]"
            )
        return []

    @classmethod
    def _config_for_index(
        cls, configs: list[dict[str, Any]], zero_index: int, auto_frame: int
    ) -> tuple[int, float]:
        cfg = configs[zero_index] if zero_index < len(configs) else {}
        try:
            frame = int(cfg.get("frame", auto_frame))
        except Exception:
            frame = int(auto_frame)
        try:
            strength = float(cfg.get("strength", 0.7))
        except Exception:
            strength = 0.7
        return frame, max(0.0, min(1.0, strength))

    @classmethod
    def _split_batch_images(cls, images: Any) -> list[Any]:
        if not cls._is_valid_image(images):
            return []
        try:
            batch = int(images.shape[0])
        except Exception:
            return [images]
        if batch <= 1:
            return [images]
        out = []
        for i in range(batch):
            img = images[i : i + 1]
            if cls._is_non_black_image(img):
                out.append(img)
            else:
                cls._log(f"批次第 {i + 1} 张图片为空/全黑，已忽略。")
        return out

    @staticmethod
    def _dynamic_image_sort_key(name: str) -> tuple[int, int]:
        # 支持 image_01 / image_1，避免旧工作流失效。
        text = str(name or "")
        if not text.startswith("image_"):
            return (1, 999999)
        try:
            return (0, int(text.split("_", 1)[1]))
        except Exception:
            return (1, 999999)

    @classmethod
    def _collect_dynamic_images(cls, kwargs: dict[str, Any]) -> list[tuple[str, Any]]:
        items = []
        for key, value in kwargs.items():
            if not str(key).startswith("image_"):
                continue
            if cls._is_empty_loader_placeholder(value):
                cls._log(f"{key} 是 64x64 空占位图，已忽略。")
                continue
            if cls._is_valid_image(value):
                items.append((key, value))
        return sorted(items, key=lambda item: cls._dynamic_image_sort_key(item[0]))

    @classmethod
    def _collect_guides(
        cls,
        latent: Any,
        guide_config_json: Any = None,
        guide_configs: list[dict[str, Any]] | None = None,
        images: Any = None,
        frame_indices: Any = None,
        strengths: Any = None,
        first_image: Any = None,
        last_image: Any = None,
        first_strength: float = 0.7,
        last_strength: float = 0.7,
        **kwargs,
    ) -> list[dict[str, Any]]:
        guides: list[dict[str, Any]] = []
        configs = (
            guide_configs
            if guide_configs is not None
            else cls._parse_config_json(guide_config_json)
        )

        dynamic_images = cls._collect_dynamic_images(kwargs)
        if dynamic_images:
            auto_frames = cls._auto_frame_indices(len(dynamic_images), latent)
            for idx, (name, img) in enumerate(dynamic_images):
                frame, strength = cls._config_for_index(configs, idx, auto_frames[idx])
                guides.append(
                    {
                        "image": img,
                        "frame_idx": frame,
                        "strength": strength,
                        "source": f"参考图 {idx + 1:02d}",
                    }
                )

        # 兼容批次输入；如果新版动态输入已接入，则批次输入排在后面继续参与。
        batch_images = cls._split_batch_images(images)
        if batch_images:
            auto_frames = cls._auto_frame_indices(len(batch_images), latent)
            user_frames = cls._parse_number_list(frame_indices, int, auto_frames)
            user_strengths = cls._parse_number_list(strengths, float, [0.7])
            frames = cls._expand_list(user_frames, len(batch_images), 0)
            strength_values = cls._expand_list(user_strengths, len(batch_images), 0.7)
            for img, f_idx, strength in zip(batch_images, frames, strength_values):
                guides.append(
                    {
                        "image": img,
                        "frame_idx": int(f_idx),
                        "strength": float(strength),
                        "source": "参考图片批次",
                    }
                )

        if cls._is_valid_image(first_image):
            guides.append(
                {
                    "image": first_image,
                    "frame_idx": 0,
                    "strength": float(first_strength),
                    "source": "首帧图片",
                }
            )
        elif cls._is_empty_loader_placeholder(first_image):
            cls._log("首帧图片是 64x64 空占位图，已忽略。")

        if cls._is_valid_image(last_image):
            guides.append(
                {
                    "image": last_image,
                    "frame_idx": -1,
                    "strength": float(last_strength),
                    "source": "尾帧图片",
                }
            )
        elif cls._is_empty_loader_placeholder(last_image):
            cls._log("尾帧图片是 64x64 空占位图，已忽略。")

        return guides

    @classmethod
    def _safe_get_latent_index(
        cls,
        guide_cls: Any,
        positive: Any,
        latent_length: int,
        encoded_image_len: int,
        frame_idx: int,
        scale_factors: Any,
    ) -> tuple[int, int]:
        try:
            frame_idx_out, latent_idx = guide_cls.get_latent_index(
                positive, latent_length, encoded_image_len, frame_idx, scale_factors
            )
            return int(frame_idx_out), int(latent_idx)
        except Exception:
            latent_span = max(1, int(encoded_image_len))
            if int(frame_idx) < 0:
                latent_idx = max(0, latent_length - latent_span)
                frame_idx_out = int(frame_idx)
            else:
                latent_idx = int(round(max(0, int(frame_idx)) / 8.0))
                latent_idx = max(
                    0, min(latent_idx, max(0, latent_length - latent_span))
                )
                frame_idx_out = int(frame_idx)
            return frame_idx_out, latent_idx

    @classmethod
    def _write_latent_only(
        cls,
        guide_cls: Any,
        get_noise_mask: Any,
        vae: Any,
        latent_out: dict[str, Any],
        guide: dict[str, Any],
        positive: Any,
    ) -> dict[str, Any]:
        latent_image = latent_out.get("samples")
        if latent_image is None or getattr(latent_image, "ndim", None) != 5:
            cls._warn(
                "视频潜空间 samples 不是 5 维 LTX latent，无法写入参考帧，已透传。"
            )
            return latent_out
        scale_factors = getattr(vae, "downscale_index_formula", None)
        if scale_factors is None:
            cls._warn(
                "VAE 缺少 downscale_index_formula，无法计算 LTX 参考帧位置，已透传。"
            )
            return latent_out

        _, _, latent_length, latent_height, latent_width = latent_image.shape
        _, encoded = guide_cls.encode(
            vae, latent_width, latent_height, guide["image"], scale_factors
        )
        _, latent_idx = cls._safe_get_latent_index(
            guide_cls,
            positive,
            int(latent_length),
            int(encoded.shape[2]),
            int(guide["frame_idx"]),
            scale_factors,
        )
        end_idx = int(latent_idx) + int(encoded.shape[2])
        if end_idx > int(latent_length):
            cls._warn(f"{guide['source']} 超出 latent 长度，已跳过。")
            return latent_out

        latent_image = latent_image.clone()
        latent_image[:, :, latent_idx:end_idx] = encoded.to(
            device=latent_image.device, dtype=latent_image.dtype
        )

        try:
            noise_mask = get_noise_mask(latent_out).clone()
        except Exception:
            torch, torch_exc = _runtime_import_torch()
            if torch is None:
                cls._warn(f"无法创建噪声遮罩：{torch_exc}")
                noise_mask = None
            else:
                noise_mask = torch.ones_like(latent_image)[:, :1]
        if noise_mask is not None:
            try:
                noise_mask[:, :, latent_idx:end_idx] = 0.0
            except Exception as exc:
                cls._warn(f"写入噪声遮罩失败，已保留原遮罩：{exc}")

        new_latent = dict(latent_out)
        new_latent["samples"] = latent_image
        if noise_mask is not None:
            new_latent["noise_mask"] = noise_mask
        return new_latent

    @classmethod
    def _apply_one_guide(
        cls,
        guide_cls: Any,
        get_noise_mask: Any,
        positive_out: Any,
        negative_out: Any,
        vae: Any,
        latent_out: dict[str, Any],
        guide: dict[str, Any],
    ) -> tuple[Any, Any, dict[str, Any]]:
        if float(guide.get("strength", 0.0)) <= 0.0:
            cls._log(f"{guide['source']} 强度为 0，已跳过。")
            return positive_out, negative_out, latent_out
        if positive_out is None and negative_out is None:
            latent_out = cls._write_latent_only(
                guide_cls, get_noise_mask, vae, latent_out, guide, positive_out
            )
            return positive_out, negative_out, latent_out

        try:
            result = guide_cls.execute(
                positive=positive_out,
                negative=negative_out,
                vae=vae,
                latent=latent_out,
                image=guide["image"],
                frame_idx=int(guide["frame_idx"]),
                strength=float(guide["strength"]),
            )
            unpacked = cls._unpack_node_output(result)
            if len(unpacked) >= 3:
                return unpacked[0], unpacked[1], unpacked[2]
            cls._warn(f"{guide['source']} 返回值数量异常，已改为只写 latent。")
        except Exception as exc:
            cls._warn(f"{guide['source']} 条件引导失败，改为只写 latent 并继续：{exc}")
        latent_out = cls._write_latent_only(
            guide_cls, get_noise_mask, vae, latent_out, guide, positive_out
        )
        return positive_out, negative_out, latent_out

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # 前端会动态增加 image_02 / image_03 ...，这里直接放行，避免后端验证拦截动态输入。
        return True

    def execute(
        self,
        vae: Any,
        latent: dict[str, Any],
        positive: Any = None,
        negative: Any = None,
        guide_config_json: Any = None,
        guide_configs: list[dict[str, Any]] | None = None,
        images: Any = None,
        frame_indices: Any = None,
        strengths: Any = None,
        first_image: Any = None,
        last_image: Any = None,
        first_strength: float = 0.7,
        last_strength: float = 0.7,
        unique_id: Any = None,
        extra_pnginfo: Any = None,
        **kwargs,
    ):
        positive_out = positive
        negative_out = negative
        latent_out = self._clone_latent_or_passthrough(latent)

        if not isinstance(latent_out, dict) or "samples" not in latent_out:
            self._warn("视频潜空间无效或缺少 samples，节点直接透传。")
            return (positive_out, negative_out, latent)

        torch, torch_exc = _runtime_import_torch()
        if torch is None:
            self._warn(f"无法加载 torch，节点直接透传：{torch_exc}")
            return (positive_out, negative_out, latent_out)

        LTXVAddGuide, get_noise_mask, ltx_exc = _runtime_import_ltx_tools()
        if LTXVAddGuide is None or get_noise_mask is None:
            self._warn(f"无法加载 LTX 引导依赖，节点直接透传：{ltx_exc}")
            return (positive_out, negative_out, latent_out)

        try:
            guides = self._collect_guides(
                latent_out,
                guide_config_json=guide_config_json,
                guide_configs=self._config_from_workflow_properties(
                    extra_pnginfo, unique_id
                )
                or None,
                images=images,
                frame_indices=frame_indices,
                strengths=strengths,
                first_image=first_image,
                last_image=last_image,
                first_strength=first_strength,
                last_strength=last_strength,
                **kwargs,
            )
        except Exception as exc:
            self._warn(f"收集参考图片失败，节点直接透传：{exc}")
            return (positive_out, negative_out, latent_out)

        if not guides:
            self._log("未检测到有效参考图片，直接透传。")
            return (positive_out, negative_out, latent_out)

        self._log(f"检测到 {len(guides)} 张有效参考图片，开始写入 LTX 引导。")
        for index, guide in enumerate(guides, start=1):
            try:
                self._log(
                    f"写入第 {index}/{len(guides)} 张：{guide['source']}，作用帧={guide['frame_idx']}，强度={guide['strength']:.3f}。"
                )
                positive_out, negative_out, latent_out = self._apply_one_guide(
                    LTXVAddGuide,
                    get_noise_mask,
                    positive_out,
                    negative_out,
                    vae,
                    latent_out,
                    guide,
                )
            except Exception as exc:
                self._warn(f"第 {index} 张参考图处理失败，已跳过并继续：{exc}")
                continue

        return (positive_out, negative_out, latent_out)


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_LTX_FirstLastFrame}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎬 多帧引导(LTX)"}
