"""GJJ 跨视角扭曲：仅使用 ComfyUI 自带的 PyTorch 与 NumPy。"""

import json
import numpy as np
import torch
import torch.nn.functional as F

try:
    from comfy.utils import ProgressBar
except Exception:
    ProgressBar = None


洋红色 = np.array([255, 0, 255], dtype=np.uint8)


def _深度转距离(深度, 反转, 远近比):
    数据 = 深度.astype(np.float64)
    if 反转:
        数据 = -数据
    下限, 上限 = np.percentile(数据, (1.0, 99.0))
    归一化 = np.clip((数据 - 下限) / (上限 - 下限 + 1e-9), 0.0, 1.0)
    比值 = max(float(远近比), 1.01)
    return 1.0 / (1.0 / 比值 + (1.0 - 1.0 / 比值) * 归一化)


def _注视矩阵(相机位置, 目标):
    前方 = 目标 - 相机位置
    前方 /= np.linalg.norm(前方) + 1e-9
    右方 = np.cross(np.array([0.0, 1.0, 0.0]), 前方)
    if np.linalg.norm(右方) < 1e-6:
        右方 = np.cross(np.array([0.0, 0.0, 1.0]), 前方)
    右方 /= np.linalg.norm(右方) + 1e-9
    下方 = np.cross(前方, 右方)
    矩阵 = np.eye(4, dtype=np.float64)
    矩阵[:3, 0] = 右方
    矩阵[:3, 1] = 下方
    矩阵[:3, 2] = 前方
    矩阵[:3, 3] = 相机位置
    return 矩阵


def _目标相机(水平角, 垂直角, 距离, 中心点):
    水平 = np.radians(-float(水平角))
    垂直 = np.radians(-float(垂直角))
    水平旋转 = np.array([
        [np.cos(水平), 0.0, np.sin(水平)],
        [0.0, 1.0, 0.0],
        [-np.sin(水平), 0.0, np.cos(水平)],
    ])
    垂直旋转 = np.array([
        [1.0, 0.0, 0.0],
        [0.0, np.cos(垂直), -np.sin(垂直)],
        [0.0, np.sin(垂直), np.cos(垂直)],
    ])
    旋转 = 水平旋转 @ 垂直旋转
    相机位置 = 中心点 + float(距离) * (旋转 @ (-中心点))
    return _注视矩阵(相机位置, 中心点)


def _角度归一化(value):
    return (float(value) + 180.0) % 360.0 - 180.0


def _解析关键帧(raw, frame_count):
    text = str(raw or "").strip()
    if not text or text in {"[]", "null"}:
        return []
    try:
        data = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"关键帧不是有效 JSON：{exc}") from None
    if not isinstance(data, list):
        raise ValueError("关键帧必须是 JSON 数组。")

    result = []
    for index, item in enumerate(data, 1):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index} 个关键帧必须是对象。")
        try:
            frame = int(round(float(item["f"])))
            azimuth = float(item["az"])
            elevation = float(item["el"])
            distance = float(item["dist"])
        except (KeyError, TypeError, ValueError):
            raise ValueError(
                f"第 {index} 个关键帧必须包含数字 f、az、el、dist。"
            ) from None
        if frame < 1 or frame > frame_count:
            raise ValueError(
                f"第 {index} 个关键帧位于第 {frame} 帧，但当前批次只有 {frame_count} 帧。"
            )
        result.append((
            frame,
            _角度归一化(azimuth),
            float(np.clip(elevation, -90.0, 90.0)),
            float(np.clip(distance, 0.2, 3.0)),
        ))
    result.sort(key=lambda item: item[0])
    frames = [item[0] for item in result]
    if len(frames) != len(set(frames)):
        raise ValueError("不能在同一帧放置两个关键帧。")
    return result


def _缓动(value, mode):
    if mode == "缓入缓出":
        return 0.5 - 0.5 * np.cos(np.pi * value)
    if mode == "缓入":
        return value * value
    if mode == "缓出":
        return 1.0 - (1.0 - value) ** 2
    return value


def _解开角度(values):
    result = [float(values[0])]
    for value in values[1:]:
        result.append(result[-1] + _角度归一化(float(value) - result[-1]))
    return result


def _插值数值(values, segment, amount, smooth):
    p1, p2 = values[segment], values[segment + 1]
    if not smooth or len(values) < 3:
        return p1 + (p2 - p1) * amount
    p0 = values[segment - 1] if segment > 0 else p1 + (p1 - p2)
    p3 = values[segment + 2] if segment + 2 < len(values) else p2 + (p2 - p1)
    return 0.5 * (
        2.0 * p1
        + (-p0 + p2) * amount
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * amount**2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * amount**3
    )


def _采样关键帧(keyframes, frame, easing, smooth):
    if frame <= keyframes[0][0]:
        return keyframes[0][1:]
    if frame >= keyframes[-1][0]:
        return keyframes[-1][1:]
    segment = next(
        index for index in range(len(keyframes) - 1)
        if keyframes[index][0] <= frame <= keyframes[index + 1][0]
    )
    first_frame = keyframes[segment][0]
    last_frame = keyframes[segment + 1][0]
    amount = _缓动((frame - first_frame) / float(last_frame - first_frame), easing)
    azimuths = _解开角度([item[1] for item in keyframes])
    elevations = [item[2] for item in keyframes]
    distances = [item[3] for item in keyframes]
    return (
        _角度归一化(_插值数值(azimuths, segment, amount, smooth)),
        float(np.clip(_插值数值(elevations, segment, amount, smooth), -90.0, 90.0)),
        float(np.clip(_插值数值(distances, segment, amount, smooth), 0.2, 3.0)),
    )


def _扭曲单帧(图像, 深度, 目标相机, 焦距, 主点横, 主点纵):
    高, 宽 = 深度.shape
    横坐标, 纵坐标 = np.meshgrid(np.arange(宽), np.arange(高))
    有效 = np.isfinite(深度) & (深度 > 0)
    if np.any(有效):
        有效 &= 深度 < np.percentile(深度[有效], 99.5)

    相机点 = np.stack([
        (横坐标 - 宽 / 2.0) / 焦距 * 深度,
        (纵坐标 - 高 / 2.0) / 焦距 * 深度,
        深度,
    ], axis=-1).reshape(-1, 3)

    逆矩阵 = np.linalg.inv(目标相机)
    目标点 = (逆矩阵[:3, :3] @ 相机点.T).T + 逆矩阵[:3, 3]
    目标深度 = 目标点[:, 2]
    安全深度 = np.where(np.abs(目标深度) < 1e-9, 1e-9, 目标深度)
    新横坐标 = np.rint(目标点[:, 0] / 安全深度 * 焦距 + 主点横).astype(np.int64)
    新纵坐标 = np.rint(目标点[:, 1] / 安全深度 * 焦距 + 主点纵).astype(np.int64)

    可见 = 有效.ravel() & (目标深度 > 0)
    顺序 = np.argsort(-目标深度)
    选择 = 顺序[可见[顺序]]
    新横坐标 = 新横坐标[选择]
    新纵坐标 = 新纵坐标[选择]
    颜色 = np.ascontiguousarray(图像.reshape(-1, 3)[选择])

    结果 = np.tile(洋红色, (高, 宽, 1))
    平面 = 结果.reshape(-1, 3)
    for 纵偏移 in range(-2, 3):
        for 横偏移 in range(-2, 3):
            横 = 新横坐标 + 横偏移
            纵 = 新纵坐标 + 纵偏移
            范围内 = (横 >= 0) & (横 < 宽) & (纵 >= 0) & (纵 < 高)
            平面[纵[范围内] * 宽 + 横[范围内]] = 颜色[范围内]
    return 结果


class GJJ_CrossViewWarp:
    """利用单目深度把图像或视频帧重投影到新的相机视角。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {
                    "tooltip": "原始图像或视频帧批次。",
                }),
                "深度图": ("IMAGE", {
                    "tooltip": "与原图对应的深度图；可直接连接常见深度预处理节点。",
                }),
                "水平角度": ("FLOAT", {
                    "default": -30.0, "min": -180.0, "max": 180.0, "step": 1.0,
                    "tooltip": "负值向左环绕，正值向右环绕；建议控制在 ±45° 内。",
                }),
                "垂直角度": ("FLOAT", {
                    "default": 20.0, "min": -90.0, "max": 90.0, "step": 1.0,
                    "tooltip": "正值升高相机，负值降低相机。",
                }),
                "相机距离": ("FLOAT", {
                    "default": 1.0, "min": 0.2, "max": 3.0, "step": 0.05,
                    "tooltip": "1 为原距离；小于 1 推近，大于 1 拉远。",
                }),
                "水平视场角": ("FLOAT", {
                    "default": 50.0, "min": 20.0, "max": 120.0, "step": 1.0,
                    "tooltip": "源画面的估算水平视场角；普通镜头可保持 50°。",
                }),
                "画面垂直偏移": ("FLOAT", {
                    "default": 0.0, "min": -0.5, "max": 0.5, "step": 0.02,
                    "tooltip": "按画面高度偏移构图；正值令输出视野上移。",
                }),
                "深度远近比": ("FLOAT", {
                    "default": 6.0, "min": 1.5, "max": 1000.0, "step": 0.5,
                    "tooltip": "越大视差越强；人像建议 2.5～4，中景建议 4～8。",
                }),
                "平滑深度": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "使用内置均值滤波减少碎孔，不需要 OpenCV。",
                }),
                "反转深度": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "当前景与背景运动方向颠倒时开启。",
                }),
            },
            "optional": {
                "启用关键帧": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "启用后按关键帧路径逐帧移动相机。",
                }),
                "关键帧": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": (
                        'JSON 数组，例如 [{"f":1,"az":5,"el":-5,"dist":0.2},'
                        '{"f":50,"az":-35,"el":0,"dist":0.8}]。'
                    ),
                }),
                "运动缓动": (["线性", "缓入缓出", "缓入", "缓出"], {
                    "default": "线性",
                    "tooltip": "控制相邻关键帧之间的速度变化。",
                }),
                "路径插值": (["线性", "平滑"], {
                    "default": "线性",
                    "tooltip": "平滑模式使用穿过各关键帧的 Catmull-Rom 曲线。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("扭曲图像",)
    OUTPUT_TOOLTIPS = ("跨视角控制图；洋红色区域表示新视角中没有原始像素的部分。",)
    FUNCTION = "生成"
    CATEGORY = "GJJ/🖼️ 图像"
    DESCRIPTION = "根据单目深度把图像或视频批次重投影到新的相机视角，洋红色代表遮挡空洞。"

    def 生成(
        self,
        图像,
        深度图,
        水平角度,
        垂直角度,
        相机距离,
        水平视场角,
        画面垂直偏移,
        深度远近比,
        平滑深度,
        反转深度,
        启用关键帧=False,
        关键帧="",
        运动缓动="线性",
        路径插值="线性",
    ):
        if 图像.ndim != 4 or 深度图.ndim != 4:
            raise ValueError("图像和深度图必须是 ComfyUI 的图像批次。")
        if 图像.shape[0] != 深度图.shape[0]:
            if 深度图.shape[0] == 1:
                深度图 = 深度图.repeat(图像.shape[0], 1, 1, 1)
            else:
                raise ValueError("深度图帧数必须与图像帧数相同，或仅提供一帧深度图。")
        if 图像.shape[1:3] != 深度图.shape[1:3]:
            raise ValueError("深度图的宽高必须与原图一致。")

        颜色张量 = 图像[..., :3].clamp(0, 1)
        if 颜色张量.shape[-1] == 1:
            颜色张量 = 颜色张量.repeat(1, 1, 1, 3)
        if 颜色张量.shape[-1] < 3:
            raise ValueError("输入图像至少需要一个颜色通道。")
        颜色 = (颜色张量.cpu().numpy() * 255.0).astype(np.uint8)
        深度张量 = 深度图.clamp(0, 1).mean(dim=-1)
        if 平滑深度:
            深度张量 = F.avg_pool2d(
                深度张量.unsqueeze(1), kernel_size=3, stride=1, padding=1
            ).squeeze(1)
        深度 = _深度转距离(深度张量.cpu().numpy(), 反转深度, 深度远近比)

        批量, 高, 宽 = 颜色.shape[:3]
        焦距 = 宽 / (2.0 * np.tan(np.radians(水平视场角) / 2.0))
        中心横 = 宽 / 2.0
        中心纵 = 高 / 2.0

        首帧深度 = 深度[0]
        横坐标, 纵坐标 = np.meshgrid(np.arange(宽), np.arange(高))
        中央区域 = (
            (横坐标 >= 宽 // 5) & (横坐标 < 4 * 宽 // 5)
            & (纵坐标 >= 高 // 8) & (纵坐标 < 4 * 高 // 5)
        )
        有效 = np.isfinite(首帧深度) & (首帧深度 > 0) & 中央区域
        if not np.any(有效):
            中心点 = np.array([0.0, 0.0, 1.05])
        else:
            三维点 = np.stack([
                (横坐标 - 中心横) / 焦距 * 首帧深度,
                (纵坐标 - 中心纵) / 焦距 * 首帧深度,
                首帧深度,
            ], axis=-1)
            中心点 = np.median(三维点[有效], axis=0)

        关键帧列表 = _解析关键帧(关键帧, 批量) if 启用关键帧 else []
        使用路径 = len(关键帧列表) >= 2 and 批量 > 1
        输出 = []
        进度 = ProgressBar(批量) if ProgressBar is not None else None
        for 索引 in range(批量):
            if 使用路径:
                当前水平, 当前垂直, 当前距离 = _采样关键帧(
                    关键帧列表,
                    索引 + 1,
                    运动缓动,
                    路径插值 == "平滑",
                )
            elif 关键帧列表:
                当前水平, 当前垂直, 当前距离 = 关键帧列表[0][1:]
            else:
                当前水平, 当前垂直, 当前距离 = 水平角度, 垂直角度, 相机距离
            相机 = _目标相机(当前水平, 当前垂直, 当前距离, 中心点)
            输出.append(_扭曲单帧(
                颜色[索引],
                深度[索引],
                相机,
                焦距,
                中心横,
                中心纵 + 画面垂直偏移 * 高,
            ))
            if 进度 is not None:
                进度.update(1)

        结果 = torch.from_numpy(np.stack(输出).astype(np.float32) / 255.0)
        return (结果,)


NODE_CLASS_MAPPINGS = {
    "GJJ_CrossViewWarp": GJJ_CrossViewWarp,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_CrossViewWarp": "🌏 跨视角深度扭曲",
}
