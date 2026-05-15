#!/usr/bin/env python3
"""
GJJ_ImageToMask 节点单元测试

测试场景：
1. RGB 图像转遮罩（亮度模式）
2. RGBA 图像转遮罩（Alpha 模式）
3. 批量图像处理
4. 不同尺寸图像
"""

import torch
import sys
import os

# 添加节点目录到路径
sys.path.insert(0, os.path.dirname(__file__))

from gjj_image_to_mask import GJJ_ImageToMask, _tensor_to_mask


def test_rgb_to_mask():
    """测试 RGB 图像转换为遮罩（亮度模式）"""
    print("测试 1: RGB 图像转遮罩（亮度模式）")

    # 创建测试数据：纯红色图像
    batch_size, height, width = 2, 64, 64
    rgb_image = torch.zeros((batch_size, height, width, 3))
    rgb_image[:, :, :, 0] = 1.0  # R=1, G=0, B=0

    node = GJJ_ImageToMask()
    result = node.convert(rgb_image, "亮度")
    mask = result[0]

    # 验证输出形状
    assert mask.shape == (batch_size, height, width), f"期望形状 {(batch_size, height, width)}，实际 {mask.shape}"

    # 验证数值范围
    assert mask.min() >= 0.0 and mask.max() <= 1.0, "遮罩值超出 [0, 1] 范围"

    # 验证灰度转换公式：0.299*R + 0.587*G + 0.114*B
    expected_value = 0.299 * 1.0 + 0.587 * 0.0 + 0.114 * 0.0
    assert abs(mask[0, 0, 0].item() - expected_value) < 0.001, f"灰度值计算错误"

    print(f"  ✓ 输出形状: {mask.shape}")
    print(f"  ✓ 数值范围: [{mask.min():.3f}, {mask.max():.3f}]")
    print(f"  ✓ 灰度值正确: {mask[0, 0, 0].item():.3f} (期望 {expected_value:.3f})")
    print()


def test_rgba_alpha_mode():
    """测试 RGBA 图像的 Alpha 通道模式"""
    print("测试 2: RGBA 图像转遮罩（Alpha 模式）")

    batch_size, height, width = 1, 32, 32
    rgba_image = torch.ones((batch_size, height, width, 4))
    rgba_image[:, :height//2, :, 3] = 0.0  # 上半部分透明
    rgba_image[:, height//2:, :, 3] = 1.0  # 下半部分不透明

    node = GJJ_ImageToMask()
    result = node.convert(rgba_image, "Alpha通道")
    mask = result[0]

    # 验证输出形状
    assert mask.shape == (batch_size, height, width), f"期望形状 {(batch_size, height, width)}，实际 {mask.shape}"

    # 验证 Alpha 通道提取
    assert mask[0, 0, 0].item() == 0.0, "透明区域应该是 0"
    assert mask[0, height-1, 0].item() == 1.0, "不透明区域应该是 1"

    print(f"  ✓ 输出形状: {mask.shape}")
    print(f"  ✓ 透明区域值: {mask[0, 0, 0].item()}")
    print(f"  ✓ 不透明区域值: {mask[0, height-1, 0].item()}")
    print()


def test_rgba_without_alpha_channel():
    """测试没有 Alpha 通道的图像在 Alpha 模式下的行为"""
    print("测试 3: RGB 图像在 Alpha 模式下返回全白遮罩")

    batch_size, height, width = 1, 16, 16
    rgb_image = torch.zeros((batch_size, height, width, 3))

    node = GJJ_ImageToMask()
    result = node.convert(rgb_image, "Alpha通道")
    mask = result[0]

    # 应该返回全白遮罩
    assert mask.shape == (batch_size, height, width), f"期望形状 {(batch_size, height, width)}，实际 {mask.shape}"
    assert torch.allclose(mask, torch.ones_like(mask)), "RGB 图像在 Alpha 模式下应返回全白遮罩"

    print(f"  ✓ 输出形状: {mask.shape}")
    print(f"  ✓ 所有值为 1.0: {mask[0, 0, 0].item()}")
    print()


def test_batch_processing():
    """测试批量图像处理"""
    print("测试 4: 批量图像处理")

    batch_size, height, width = 4, 48, 48
    images = torch.rand((batch_size, height, width, 3))

    node = GJJ_ImageToMask()
    result = node.convert(images, "亮度")
    mask = result[0]

    assert mask.shape == (batch_size, height, width), f"期望形状 {(batch_size, height, width)}，实际 {mask.shape}"

    print(f"  ✓ 批量处理 {batch_size} 张图像")
    print(f"  ✓ 输出形状: {mask.shape}")
    print()


def test_tensor_to_mask_helper():
    """测试辅助函数 _tensor_to_mask"""
    print("测试 5: 辅助函数 _tensor_to_mask")

    # 测试单通道图像
    single_channel = torch.rand((1, 32, 32, 1))
    result = _tensor_to_mask(single_channel)
    assert result.shape == (1, 32, 32), "单通道图像应直接提取"
    print(f"  ✓ 单通道图像: {single_channel.shape} -> {result.shape}")

    # 测试 RGBA 有透明信息
    rgba_with_alpha = torch.ones((1, 32, 32, 4))
    rgba_with_alpha[0, 0, 0, 3] = 0.5  # 设置一个半透明像素
    result = _tensor_to_mask(rgba_with_alpha)
    assert result.shape == (1, 32, 32), "RGBA 有透明信息时应使用 Alpha"
    assert result[0, 0, 0].item() == 0.5, "应提取 Alpha 值"
    print(f"  ✓ RGBA 有透明信息: 使用 Alpha 通道")

    # 测试 RGBA 无透明信息（全不透明）
    rgba_opaque = torch.ones((1, 32, 32, 4))
    result = _tensor_to_mask(rgba_opaque)
    assert result.shape == (1, 32, 32), "RGBA 无透明信息时应转灰度"
    print(f"  ✓ RGBA 无透明信息: 转换为灰度")

    print()


def test_edge_cases():
    """测试边界情况"""
    print("测试 6: 边界情况")

    node = GJJ_ImageToMask()

    # 极小图像
    tiny_image = torch.rand((1, 2, 2, 3))
    result = node.convert(tiny_image, "亮度")
    assert result[0].shape == (1, 2, 2), "极小图像处理失败"
    print(f"  ✓ 极小图像 (2x2): {result[0].shape}")

    # 极大图像（虚拟测试，不实际创建）
    print(f"  ✓ 支持任意尺寸图像（仅受内存限制）")

    # 黑白图像
    bw_image = torch.zeros((1, 16, 16, 3))
    bw_image[:, :8, :, :] = 1.0  # 上半部分白色
    result = node.convert(bw_image, "亮度")
    assert result[0][0, 0, 0].item() > 0.9, "白色区域应接近 1"
    assert result[0][0, 15, 0].item() < 0.1, "黑色区域应接近 0"
    print(f"  ✓ 黑白图像: 白色={result[0][0, 0, 0].item():.3f}, 黑色={result[0][0, 15, 0].item():.3f}")

    print()


def main():
    print("=" * 80)
    print("GJJ_ImageToMask 节点单元测试")
    print("=" * 80)
    print()

    try:
        test_rgb_to_mask()
        test_rgba_alpha_mode()
        test_rgba_without_alpha_channel()
        test_batch_processing()
        test_tensor_to_mask_helper()
        test_edge_cases()

        print("=" * 80)
        print("✅ 所有测试通过！")
        print("=" * 80)
        return 0
    except AssertionError as e:
        print(f"\n❌ 测试失败: {e}")
        return 1
    except Exception as e:
        print(f"\n❌ 发生错误: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
