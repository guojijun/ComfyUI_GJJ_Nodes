from __future__ import annotations

import node_helpers
import nodes
import numpy as np
import torch

import comfy.latent_formats
import comfy.model_management
import comfy.utils


NODE_NAME = "GJJ_WanCameraImageToVideo"
NODE_DISPLAY_NAME = "🎥 Wan相机图生视频"


CAMERA_PRESETS = {
    "静止": "Static",
    "向上平移": "Pan Up",
    "向下平移": "Pan Down",
    "向左平移": "Pan Left",
    "向右平移": "Pan Right",
    "推近": "Zoom In",
    "拉远": "Zoom Out",
    "逆时针旋转": "Anti Clockwise (ACW)",
    "顺时针旋转": "ClockWise (CW)",
}

CAMERA_DICT = {
    "base_T_norm": 1.5,
    "base_angle": np.pi / 3,
    "Static": {"angle": [0.0, 0.0, 0.0], "T": [0.0, 0.0, 0.0]},
    "Pan Up": {"angle": [0.0, 0.0, 0.0], "T": [0.0, -1.0, 0.0]},
    "Pan Down": {"angle": [0.0, 0.0, 0.0], "T": [0.0, 1.0, 0.0]},
    "Pan Left": {"angle": [0.0, 0.0, 0.0], "T": [-1.0, 0.0, 0.0]},
    "Pan Right": {"angle": [0.0, 0.0, 0.0], "T": [1.0, 0.0, 0.0]},
    "Zoom In": {"angle": [0.0, 0.0, 0.0], "T": [0.0, 0.0, 2.0]},
    "Zoom Out": {"angle": [0.0, 0.0, 0.0], "T": [0.0, 0.0, -2.0]},
    "Anti Clockwise (ACW)": {"angle": [0.0, 0.0, -1.0], "T": [0.0, 0.0, 0.0]},
    "ClockWise (CW)": {"angle": [0.0, 0.0, 1.0], "T": [0.0, 0.0, 0.0]},
}


class _Camera:
    def __init__(self, entry):
        self.fx, self.fy, self.cx, self.cy = entry[1:5]
        self.c2w_mat = np.array(entry[7:]).reshape(4, 4)
        self.w2c_mat = np.linalg.inv(self.c2w_mat)


def _get_relative_pose(cam_params):
    abs_w2cs = [cam_param.w2c_mat for cam_param in cam_params]
    abs_c2ws = [cam_param.c2w_mat for cam_param in cam_params]
    target_cam_c2w = np.array(
        [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ]
    )
    abs2rel = target_cam_c2w @ abs_w2cs[0]
    poses = [target_cam_c2w] + [abs2rel @ abs_c2w for abs_c2w in abs_c2ws[1:]]
    return np.array(poses, dtype=np.float32)


def _ray_condition(k, c2w, height, width, device):
    batch = k.shape[0]
    y, x = torch.meshgrid(
        torch.linspace(0, height - 1, height, device=device, dtype=c2w.dtype),
        torch.linspace(0, width - 1, width, device=device, dtype=c2w.dtype),
        indexing="ij",
    )
    x = x.reshape([1, 1, height * width]).expand([batch, 1, height * width]) + 0.5
    y = y.reshape([1, 1, height * width]).expand([batch, 1, height * width]) + 0.5

    fx, fy, cx, cy = k.chunk(4, dim=-1)
    zs = torch.ones_like(x)
    xs = (x - cx) / fx * zs
    ys = (y - cy) / fy * zs
    zs = zs.expand_as(ys)

    directions = torch.stack((xs, ys, zs), dim=-1)
    directions = directions / directions.norm(dim=-1, keepdim=True)
    rays_d = directions @ c2w[..., :3, :3].transpose(-1, -2)
    rays_o = c2w[..., :3, 3]
    rays_o = rays_o[:, :, None].expand_as(rays_d)
    rays_dxo = torch.cross(rays_o, rays_d, dim=-1)
    plucker = torch.cat([rays_dxo, rays_d], dim=-1)
    return plucker.reshape(batch, c2w.shape[1], height, width, 6)


def _process_pose_params(cam_params, width, height, device):
    cameras = [_Camera(cam_param) for cam_param in cam_params]
    sample_ratio = width / height
    pose_ratio = 1280 / 720

    if pose_ratio > sample_ratio:
        resized_w = height * pose_ratio
        for camera in cameras:
            camera.fx = resized_w * camera.fx / width
    else:
        resized_h = width / pose_ratio
        for camera in cameras:
            camera.fy = resized_h * camera.fy / height

    intrinsic = np.asarray(
        [[camera.fx * width, camera.fy * height, camera.cx * width, camera.cy * height] for camera in cameras],
        dtype=np.float32,
    )
    k = torch.as_tensor(intrinsic)[None]
    c2ws = torch.as_tensor(_get_relative_pose(cameras))[None]
    embedding = _ray_condition(k, c2ws, height, width, device=device)[0].permute(0, 3, 1, 2).contiguous()
    return embedding[None].permute(0, 1, 3, 4, 2)[0]


def _get_camera_motion(angle, translation, speed, frames):
    def compute_rotation(angles):
        theta_x, theta_y, theta_z = angles
        rx = np.array([[1, 0, 0], [0, np.cos(theta_x), -np.sin(theta_x)], [0, np.sin(theta_x), np.cos(theta_x)]])
        ry = np.array([[np.cos(theta_y), 0, np.sin(theta_y)], [0, 1, 0], [-np.sin(theta_y), 0, np.cos(theta_y)]])
        rz = np.array([[np.cos(theta_z), -np.sin(theta_z), 0], [np.sin(theta_z), np.cos(theta_z), 0], [0, 0, 1]])
        return np.dot(rz, np.dot(ry, rx))

    rt_values = []
    for index in range(frames):
        ratio = index / frames
        rotation = compute_rotation(ratio * speed * CAMERA_DICT["base_angle"] * angle)
        trans = ratio * speed * CAMERA_DICT["base_T_norm"] * translation.reshape(3, 1)
        rt_values.append(np.concatenate([rotation, trans], axis=1))
    return np.stack(rt_values)


def _make_camera_embedding(camera_pose, width, height, length, speed, fx, fy, cx, cy):
    pose_key = CAMERA_PRESETS.get(camera_pose, camera_pose)
    if pose_key not in CAMERA_DICT:
        raise RuntimeError(f"未知相机运动预设：{camera_pose}")

    angle = np.array(CAMERA_DICT[pose_key]["angle"])
    translation = np.array(CAMERA_DICT[pose_key]["T"])
    rt_values = _get_camera_motion(angle, translation, speed, length)

    trajectories = []
    for camera_pose_matrix in rt_values.tolist():
        trajectory = [fx, fy, cx, cy, 0, 0]
        trajectory.extend(camera_pose_matrix[0])
        trajectory.extend(camera_pose_matrix[1])
        trajectory.extend(camera_pose_matrix[2])
        trajectory.extend([0, 0, 0, 1])
        trajectories.append(trajectory)

    cam_params = np.array([[float(value) for value in pose] for pose in trajectories])
    cam_params = np.concatenate([np.zeros_like(cam_params[:, :1]), cam_params], 1)
    camera_video = _process_pose_params(
        cam_params,
        width=width,
        height=height,
        device=comfy.model_management.intermediate_device(),
    )
    camera_video = camera_video.permute([3, 0, 1, 2]).unsqueeze(0).to(device=comfy.model_management.intermediate_device())
    camera_video = torch.concat(
        [
            torch.repeat_interleave(camera_video[:, :, 0:1], repeats=4, dim=2),
            camera_video[:, :, 1:],
        ],
        dim=2,
    ).transpose(1, 2)

    batch, frames, channels, cam_height, cam_width = camera_video.shape
    camera_video = camera_video.contiguous().view(batch, frames // 4, 4, channels, cam_height, cam_width).transpose(2, 3)
    return camera_video.contiguous().view(batch, frames // 4, channels * 4, cam_height, cam_width).transpose(1, 2)


def _coerce_int(value, default, name):
    if value is None:
        return int(default)
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{name} 参数无效：{value}") from error


def _coerce_float(value, default, name):
    if value is None:
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{name} 参数无效：{value}") from error


def _infer_image_size(image):
    if image is None or not hasattr(image, "shape") or len(image.shape) < 3:
        return None, None
    return int(image.shape[2]), int(image.shape[1])


class GJJ_WanCameraImageToVideo:
    CATEGORY = "GJJ/🎬 视频/生成"
    FUNCTION = "process"
    DESCRIPTION = "把 Wan 相机嵌入和 Wan 相机图生视频编码合并到一个 GJJ 零依赖节点。"
    SEARCH_ALIASES = [
        "WanCameraImageToVideo",
        "WanCameraEmbedding",
        "Wan相机",
        "相机图生视频",
        "camera i2v",
    ]

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "视频 latent")
    OUTPUT_TOOLTIPS = (
        "已写入起始图、CLIP 图像条件和相机控制条件的正向条件。",
        "已写入起始图、CLIP 图像条件和相机控制条件的负向条件。",
        "Wan 视频模型使用的空 latent，尺寸和帧数与面板参数一致。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": (
                    "CONDITIONING",
                    {"display_name": "正向条件", "tooltip": "接文本编码后的正向条件；节点会追加图像和相机控制信息。"},
                ),
                "negative": (
                    "CONDITIONING",
                    {"display_name": "负向条件", "tooltip": "接文本编码后的负向条件；节点会同步追加图像和相机控制信息。"},
                ),
                "vae": (
                    "VAE",
                    {"display_name": "VAE", "tooltip": "用于把起始图编码成 Wan 图生视频所需的 latent 条件。"},
                ),
                "camera_pose": (
                    list(CAMERA_PRESETS.keys()),
                    {"default": "向左平移", "display_name": "相机运动", "tooltip": "选择内置相机轨迹，会自动生成相机控制条件。"},
                ),
                "width": (
                    "INT",
                    {"default": 832, "min": 16, "max": nodes.MAX_RESOLUTION, "step": 16, "display_name": "宽度", "tooltip": "视频目标宽度，也用于生成相机嵌入。"},
                ),
                "height": (
                    "INT",
                    {"default": 480, "min": 16, "max": nodes.MAX_RESOLUTION, "step": 16, "display_name": "高度", "tooltip": "视频目标高度，也用于生成相机嵌入。"},
                ),
                "length": (
                    "INT",
                    {"default": 81, "min": 1, "max": nodes.MAX_RESOLUTION, "step": 4, "display_name": "帧数", "tooltip": "目标视频帧数；Wan latent 长度按 4 帧压缩规则计算。"},
                ),
                "batch_size": (
                    "INT",
                    {"default": 1, "min": 1, "max": 4096, "display_name": "批次数", "tooltip": "一次生成的视频批次数。"},
                ),
                "speed": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1, "display_name": "相机速度", "tooltip": "控制相机运动幅度，0 为近似静止，数值越大运动越明显。"},
                ),
                "fx": (
                    "FLOAT",
                    {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.000000001, "display_name": "焦距 X", "tooltip": "归一化水平焦距，通常保持 0.5。"},
                ),
                "fy": (
                    "FLOAT",
                    {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.000000001, "display_name": "焦距 Y", "tooltip": "归一化垂直焦距，通常保持 0.5。"},
                ),
                "cx": (
                    "FLOAT",
                    {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "中心点 X", "tooltip": "归一化水平主点位置，默认画面中心。"},
                ),
                "cy": (
                    "FLOAT",
                    {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "中心点 Y", "tooltip": "归一化垂直主点位置，默认画面中心。"},
                ),
            },
            "optional": {
                "start_image": (
                    "IMAGE",
                    {"display_name": "起始图", "tooltip": "可选起始图；连接后会编码为 Wan 图生视频的首帧约束。"},
                ),
                "clip_vision_output": (
                    "CLIP_VISION_OUTPUT",
                    {"display_name": "CLIP图像条件", "tooltip": "可选 CLIP Vision 输出，会写入正负条件增强图像一致性。"},
                ),
            },
        }

    def process(
        self,
        positive,
        negative,
        vae,
        camera_pose,
        width,
        height,
        length,
        batch_size,
        speed,
        fx,
        fy,
        cx,
        cy,
        start_image=None,
        clip_vision_output=None,
    ):
        image_width, image_height = _infer_image_size(start_image)
        width = _coerce_int(width, image_width or 832, "宽度")
        height = _coerce_int(height, image_height or 480, "高度")
        length = _coerce_int(length, 81, "帧数")
        batch_size = _coerce_int(batch_size, 1, "批次数")
        speed = _coerce_float(speed, 1.0, "相机速度")
        fx = _coerce_float(fx, 0.5, "焦距 X")
        fy = _coerce_float(fy, 0.5, "焦距 Y")
        cx = _coerce_float(cx, 0.5, "中心点 X")
        cy = _coerce_float(cy, 0.5, "中心点 Y")

        if width % 8 != 0 or height % 8 != 0:
            raise RuntimeError("宽度和高度必须能被 8 整除，才能生成 Wan latent。")
        if (length - 1) % 4 != 0:
            raise RuntimeError("帧数必须符合 Wan 的 4n+1 规则，例如 81、85、89。")

        device = comfy.model_management.intermediate_device()
        latent = torch.zeros([batch_size, 16, ((length - 1) // 4) + 1, height // 8, width // 8], device=device)
        camera_conditions = _make_camera_embedding(camera_pose, width, height, length, speed, fx, fy, cx, cy)

        if start_image is not None:
            concat_latent = torch.zeros_like(latent)
            concat_latent = comfy.latent_formats.Wan21().process_out(concat_latent)
            start_image = comfy.utils.common_upscale(start_image[:length].movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
            concat_latent_image = vae.encode(start_image[:, :, :, :3])
            concat_latent[:, :, : concat_latent_image.shape[2]] = concat_latent_image[:, :, : concat_latent.shape[2]]
            mask = torch.ones((1, 1, latent.shape[2] * 4, latent.shape[-2], latent.shape[-1]))
            mask[:, :, : start_image.shape[0] + 3] = 0.0
            mask = mask.view(1, mask.shape[2] // 4, 4, mask.shape[3], mask.shape[4]).transpose(1, 2)
            positive = node_helpers.conditioning_set_values(positive, {"concat_latent_image": concat_latent, "concat_mask": mask})
            negative = node_helpers.conditioning_set_values(negative, {"concat_latent_image": concat_latent, "concat_mask": mask})

        positive = node_helpers.conditioning_set_values(positive, {"camera_conditions": camera_conditions})
        negative = node_helpers.conditioning_set_values(negative, {"camera_conditions": camera_conditions})

        if clip_vision_output is not None:
            positive = node_helpers.conditioning_set_values(positive, {"clip_vision_output": clip_vision_output})
            negative = node_helpers.conditioning_set_values(negative, {"clip_vision_output": clip_vision_output})

        return (positive, negative, {"samples": latent})


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_WanCameraImageToVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}
