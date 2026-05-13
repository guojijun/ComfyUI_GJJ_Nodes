"""
GJJ · 🦴 OpenPose 姿态检测
零依赖单节点，内联 OpenPose 全部代码
"""

import os
import sys
import json
import math
import warnings
from collections import OrderedDict
from typing import List, NamedTuple, Tuple, Union

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter

import folder_paths
import comfy.model_management as model_management
import comfy.utils

# ============================================================================
# 纯 numpy 连通域标记（替代 skimage.measure.label）
# ============================================================================

def _label_components(binary):
    """纯 numpy 实现连通域标记（两遍扫描，8-连通），返回 (labels, num_labels)。"""
    h, w = binary.shape
    labels = np.zeros((h, w), dtype=np.int32)
    current_label = 0
    equivalence = {}

    for y in range(h):
        for x in range(w):
            if binary[y, x] == 0:
                continue
            neighbors = []
            if y > 0 and binary[y-1, x]:
                neighbors.append(labels[y-1, x])
            if x > 0 and binary[y, x-1]:
                neighbors.append(labels[y, x-1])
            if y > 0 and x > 0 and binary[y-1, x-1]:
                neighbors.append(labels[y-1, x-1])
            if y > 0 and x < w-1 and binary[y-1, x+1]:
                neighbors.append(labels[y-1, x+1])
            if not neighbors:
                current_label += 1
                labels[y, x] = current_label
            else:
                min_label = min(neighbors)
                labels[y, x] = min_label
                for n in neighbors:
                    if n != min_label:
                        equivalence[n] = min_label

    for y in range(h):
        for x in range(w):
            if labels[y, x] > 0:
                val = labels[y, x]
                while val in equivalence:
                    val = equivalence[val]
                labels[y, x] = val

    unique_labels = np.unique(labels)
    unique_labels = unique_labels[unique_labels > 0]
    num_labels = len(unique_labels)
    if num_labels > 0:
        mapping = {old: new + 1 for new, old in enumerate(unique_labels)}
        for y in range(h):
            for x in range(w):
                if labels[y, x] > 0:
                    labels[y, x] = mapping[labels[y, x]]
    return labels, num_labels

# ============================================================================
# 内联 OpenPose 全部代码（零外部自定义节点依赖）
# ============================================================================

class Keypoint(NamedTuple):
    x: float
    y: float
    score: float = 1.0
    id: int = -1

class BodyResult(NamedTuple):
    keypoints: List[Union[Keypoint, None]]
    total_score: float
    total_parts: int

HandResult = List[Keypoint]
FaceResult = List[Keypoint]

class PoseResult(NamedTuple):
    body: BodyResult
    left_hand: Union[HandResult, None]
    right_hand: Union[HandResult, None]
    face: Union[FaceResult, None]

# ============================================================================
# 内联 model.py - 网络模型定义
# ============================================================================

def _make_layers(block, no_relu_layers):
    layers = []
    for layer_name, v in block.items():
        if 'pool' in layer_name:
            layer = nn.MaxPool2d(kernel_size=v[0], stride=v[1], padding=v[2])
            layers.append((layer_name, layer))
        else:
            conv2d = nn.Conv2d(in_channels=v[0], out_channels=v[1],
                               kernel_size=v[2], stride=v[3], padding=v[4])
            layers.append((layer_name, conv2d))
            if layer_name not in no_relu_layers:
                layers.append(('relu_' + layer_name, nn.ReLU(inplace=True)))
    return nn.Sequential(OrderedDict(layers))

class _bodypose_model(nn.Module):
    def __init__(self):
        super(_bodypose_model, self).__init__()
        no_relu_layers = ['conv5_5_CPM_L1', 'conv5_5_CPM_L2', 'Mconv7_stage2_L1',
                          'Mconv7_stage2_L2', 'Mconv7_stage3_L1', 'Mconv7_stage3_L2',
                          'Mconv7_stage4_L1', 'Mconv7_stage4_L2', 'Mconv7_stage5_L1',
                          'Mconv7_stage5_L2', 'Mconv7_stage6_L1', 'Mconv7_stage6_L1']
        blocks = {}
        block0 = OrderedDict([
            ('conv1_1', [3, 64, 3, 1, 1]),
            ('conv1_2', [64, 64, 3, 1, 1]),
            ('pool1_stage1', [2, 2, 0]),
            ('conv2_1', [64, 128, 3, 1, 1]),
            ('conv2_2', [128, 128, 3, 1, 1]),
            ('pool2_stage1', [2, 2, 0]),
            ('conv3_1', [128, 256, 3, 1, 1]),
            ('conv3_2', [256, 256, 3, 1, 1]),
            ('conv3_3', [256, 256, 3, 1, 1]),
            ('conv3_4', [256, 256, 3, 1, 1]),
            ('pool3_stage1', [2, 2, 0]),
            ('conv4_1', [256, 512, 3, 1, 1]),
            ('conv4_2', [512, 512, 3, 1, 1]),
            ('conv4_3_CPM', [512, 256, 3, 1, 1]),
            ('conv4_4_CPM', [256, 128, 3, 1, 1])
        ])
        block1_1 = OrderedDict([
            ('conv5_1_CPM_L1', [128, 128, 3, 1, 1]),
            ('conv5_2_CPM_L1', [128, 128, 3, 1, 1]),
            ('conv5_3_CPM_L1', [128, 128, 3, 1, 1]),
            ('conv5_4_CPM_L1', [128, 512, 1, 1, 0]),
            ('conv5_5_CPM_L1', [512, 38, 1, 1, 0])
        ])
        block1_2 = OrderedDict([
            ('conv5_1_CPM_L2', [128, 128, 3, 1, 1]),
            ('conv5_2_CPM_L2', [128, 128, 3, 1, 1]),
            ('conv5_3_CPM_L2', [128, 128, 3, 1, 1]),
            ('conv5_4_CPM_L2', [128, 512, 1, 1, 0]),
            ('conv5_5_CPM_L2', [512, 19, 1, 1, 0])
        ])
        blocks['block1_1'] = block1_1
        blocks['block1_2'] = block1_2
        self.model0 = _make_layers(block0, no_relu_layers)
        for i in range(2, 7):
            blocks['block%d_1' % i] = OrderedDict([
                ('Mconv1_stage%d_L1' % i, [185, 128, 7, 1, 3]),
                ('Mconv2_stage%d_L1' % i, [128, 128, 7, 1, 3]),
                ('Mconv3_stage%d_L1' % i, [128, 128, 7, 1, 3]),
                ('Mconv4_stage%d_L1' % i, [128, 128, 7, 1, 3]),
                ('Mconv5_stage%d_L1' % i, [128, 128, 7, 1, 3]),
                ('Mconv6_stage%d_L1' % i, [128, 128, 1, 1, 0]),
                ('Mconv7_stage%d_L1' % i, [128, 38, 1, 1, 0])
            ])
            blocks['block%d_2' % i] = OrderedDict([
                ('Mconv1_stage%d_L2' % i, [185, 128, 7, 1, 3]),
                ('Mconv2_stage%d_L2' % i, [128, 128, 7, 1, 3]),
                ('Mconv3_stage%d_L2' % i, [128, 128, 7, 1, 3]),
                ('Mconv4_stage%d_L2' % i, [128, 128, 7, 1, 3]),
                ('Mconv5_stage%d_L2' % i, [128, 128, 7, 1, 3]),
                ('Mconv6_stage%d_L2' % i, [128, 128, 1, 1, 0]),
                ('Mconv7_stage%d_L2' % i, [128, 19, 1, 1, 0])
            ])
        for k in blocks.keys():
            blocks[k] = _make_layers(blocks[k], no_relu_layers)
        self.model1_1 = blocks['block1_1']
        self.model2_1 = blocks['block2_1']
        self.model3_1 = blocks['block3_1']
        self.model4_1 = blocks['block4_1']
        self.model5_1 = blocks['block5_1']
        self.model6_1 = blocks['block6_1']
        self.model1_2 = blocks['block1_2']
        self.model2_2 = blocks['block2_2']
        self.model3_2 = blocks['block3_2']
        self.model4_2 = blocks['block4_2']
        self.model5_2 = blocks['block5_2']
        self.model6_2 = blocks['block6_2']

    def forward(self, x):
        out1 = self.model0(x)
        out1_1 = self.model1_1(out1)
        out1_2 = self.model1_2(out1)
        out2 = torch.cat([out1_1, out1_2, out1], 1)
        out2_1 = self.model2_1(out2)
        out2_2 = self.model2_2(out2)
        out3 = torch.cat([out2_1, out2_2, out1], 1)
        out3_1 = self.model3_1(out3)
        out3_2 = self.model3_2(out3)
        out4 = torch.cat([out3_1, out3_2, out1], 1)
        out4_1 = self.model4_1(out4)
        out4_2 = self.model4_2(out4)
        out5 = torch.cat([out4_1, out4_2, out1], 1)
        out5_1 = self.model5_1(out5)
        out5_2 = self.model5_2(out5)
        out6 = torch.cat([out5_1, out5_2, out1], 1)
        out6_1 = self.model6_1(out6)
        out6_2 = self.model6_2(out6)
        return out6_1, out6_2

class _handpose_model(nn.Module):
    def __init__(self):
        super(_handpose_model, self).__init__()
        no_relu_layers = ['conv6_2_CPM', 'Mconv7_stage2', 'Mconv7_stage3',
                          'Mconv7_stage4', 'Mconv7_stage5', 'Mconv7_stage6']
        block1_0 = OrderedDict([
            ('conv1_1', [3, 64, 3, 1, 1]),
            ('conv1_2', [64, 64, 3, 1, 1]),
            ('pool1_stage1', [2, 2, 0]),
            ('conv2_1', [64, 128, 3, 1, 1]),
            ('conv2_2', [128, 128, 3, 1, 1]),
            ('pool2_stage1', [2, 2, 0]),
            ('conv3_1', [128, 256, 3, 1, 1]),
            ('conv3_2', [256, 256, 3, 1, 1]),
            ('conv3_3', [256, 256, 3, 1, 1]),
            ('conv3_4', [256, 256, 3, 1, 1]),
            ('pool3_stage1', [2, 2, 0]),
            ('conv4_1', [256, 512, 3, 1, 1]),
            ('conv4_2', [512, 512, 3, 1, 1]),
            ('conv4_3', [512, 512, 3, 1, 1]),
            ('conv4_4', [512, 512, 3, 1, 1]),
            ('conv5_1', [512, 512, 3, 1, 1]),
            ('conv5_2', [512, 512, 3, 1, 1]),
            ('conv5_3_CPM', [512, 128, 3, 1, 1])
        ])
        block1_1 = OrderedDict([
            ('conv6_1_CPM', [128, 512, 1, 1, 0]),
            ('conv6_2_CPM', [512, 22, 1, 1, 0])
        ])
        blocks = {}
        blocks['block1_0'] = block1_0
        blocks['block1_1'] = block1_1
        for i in range(2, 7):
            blocks['block%d' % i] = OrderedDict([
                ('Mconv1_stage%d' % i, [150, 128, 7, 1, 3]),
                ('Mconv2_stage%d' % i, [128, 128, 7, 1, 3]),
                ('Mconv3_stage%d' % i, [128, 128, 7, 1, 3]),
                ('Mconv4_stage%d' % i, [128, 128, 7, 1, 3]),
                ('Mconv5_stage%d' % i, [128, 128, 7, 1, 3]),
                ('Mconv6_stage%d' % i, [128, 128, 1, 1, 0]),
                ('Mconv7_stage%d' % i, [128, 22, 1, 1, 0])
            ])
        for k in blocks.keys():
            blocks[k] = _make_layers(blocks[k], no_relu_layers)
        self.model1_0 = blocks['block1_0']
        self.model1_1 = blocks['block1_1']
        self.model2 = blocks['block2']
        self.model3 = blocks['block3']
        self.model4 = blocks['block4']
        self.model5 = blocks['block5']
        self.model6 = blocks['block6']

    def forward(self, x):
        out1_0 = self.model1_0(x)
        out1_1 = self.model1_1(out1_0)
        concat_stage2 = torch.cat([out1_1, out1_0], 1)
        out_stage2 = self.model2(concat_stage2)
        concat_stage3 = torch.cat([out_stage2, out1_0], 1)
        out_stage3 = self.model3(concat_stage3)
        concat_stage4 = torch.cat([out_stage3, out1_0], 1)
        out_stage4 = self.model4(concat_stage4)
        concat_stage5 = torch.cat([out_stage4, out1_0], 1)
        out_stage5 = self.model5(concat_stage5)
        concat_stage6 = torch.cat([out_stage5, out1_0], 1)
        out_stage6 = self.model6(concat_stage6)
        return out_stage6

class _FaceNet(nn.Module):
    def __init__(self):
        super(_FaceNet, self).__init__()
        self.relu = nn.ReLU()
        self.max_pooling_2d = nn.MaxPool2d(kernel_size=2, stride=2)
        self.conv1_1 = nn.Conv2d(3, 64, 3, 1, 1)
        self.conv1_2 = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv2_1 = nn.Conv2d(64, 128, 3, 1, 1)
        self.conv2_2 = nn.Conv2d(128, 128, 3, 1, 1)
        self.conv3_1 = nn.Conv2d(128, 256, 3, 1, 1)
        self.conv3_2 = nn.Conv2d(256, 256, 3, 1, 1)
        self.conv3_3 = nn.Conv2d(256, 256, 3, 1, 1)
        self.conv3_4 = nn.Conv2d(256, 256, 3, 1, 1)
        self.conv4_1 = nn.Conv2d(256, 512, 3, 1, 1)
        self.conv4_2 = nn.Conv2d(512, 512, 3, 1, 1)
        self.conv4_3 = nn.Conv2d(512, 512, 3, 1, 1)
        self.conv4_4 = nn.Conv2d(512, 512, 3, 1, 1)
        self.conv5_1 = nn.Conv2d(512, 512, 3, 1, 1)
        self.conv5_2 = nn.Conv2d(512, 512, 3, 1, 1)
        self.conv5_3_CPM = nn.Conv2d(512, 128, 3, 1, 1)
        self.conv6_1_CPM = nn.Conv2d(128, 512, 1, 1, 0)
        self.conv6_2_CPM = nn.Conv2d(512, 71, 1, 1, 0)
        self.Mconv1_stage2 = nn.Conv2d(199, 128, 7, 1, 3)
        self.Mconv2_stage2 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv3_stage2 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv4_stage2 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv5_stage2 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv6_stage2 = nn.Conv2d(128, 128, 1, 1, 0)
        self.Mconv7_stage2 = nn.Conv2d(128, 71, 1, 1, 0)
        self.Mconv1_stage3 = nn.Conv2d(199, 128, 7, 1, 3)
        self.Mconv2_stage3 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv3_stage3 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv4_stage3 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv5_stage3 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv6_stage3 = nn.Conv2d(128, 128, 1, 1, 0)
        self.Mconv7_stage3 = nn.Conv2d(128, 71, 1, 1, 0)
        self.Mconv1_stage4 = nn.Conv2d(199, 128, 7, 1, 3)
        self.Mconv2_stage4 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv3_stage4 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv4_stage4 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv5_stage4 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv6_stage4 = nn.Conv2d(128, 128, 1, 1, 0)
        self.Mconv7_stage4 = nn.Conv2d(128, 71, 1, 1, 0)
        self.Mconv1_stage5 = nn.Conv2d(199, 128, 7, 1, 3)
        self.Mconv2_stage5 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv3_stage5 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv4_stage5 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv5_stage5 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv6_stage5 = nn.Conv2d(128, 128, 1, 1, 0)
        self.Mconv7_stage5 = nn.Conv2d(128, 71, 1, 1, 0)
        self.Mconv1_stage6 = nn.Conv2d(199, 128, 7, 1, 3)
        self.Mconv2_stage6 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv3_stage6 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv4_stage6 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv5_stage6 = nn.Conv2d(128, 128, 7, 1, 3)
        self.Mconv6_stage6 = nn.Conv2d(128, 128, 1, 1, 0)
        self.Mconv7_stage6 = nn.Conv2d(128, 71, 1, 1, 0)
        for m in self.modules():
            if isinstance(m, nn.Conv2d):
                nn.init.constant_(m.bias, 0)

    def forward(self, x):
        heatmaps = []
        h = self.relu(self.conv1_1(x))
        h = self.relu(self.conv1_2(h))
        h = self.max_pooling_2d(h)
        h = self.relu(self.conv2_1(h))
        h = self.relu(self.conv2_2(h))
        h = self.max_pooling_2d(h)
        h = self.relu(self.conv3_1(h))
        h = self.relu(self.conv3_2(h))
        h = self.relu(self.conv3_3(h))
        h = self.relu(self.conv3_4(h))
        h = self.max_pooling_2d(h)
        h = self.relu(self.conv4_1(h))
        h = self.relu(self.conv4_2(h))
        h = self.relu(self.conv4_3(h))
        h = self.relu(self.conv4_4(h))
        h = self.relu(self.conv5_1(h))
        h = self.relu(self.conv5_2(h))
        h = self.relu(self.conv5_3_CPM(h))
        feature_map = h
        h = self.relu(self.conv6_1_CPM(h))
        h = self.conv6_2_CPM(h)
        heatmaps.append(h)
        for stage in range(2, 7):
            h = torch.cat([h, feature_map], dim=1)
            m1 = getattr(self, f'Mconv1_stage{stage}')
            m2 = getattr(self, f'Mconv2_stage{stage}')
            m3 = getattr(self, f'Mconv3_stage{stage}')
            m4 = getattr(self, f'Mconv4_stage{stage}')
            m5 = getattr(self, f'Mconv5_stage{stage}')
            m6 = getattr(self, f'Mconv6_stage{stage}')
            m7 = getattr(self, f'Mconv7_stage{stage}')
            h = self.relu(m1(h))
            h = self.relu(m2(h))
            h = self.relu(m3(h))
            h = self.relu(m4(h))
            h = self.relu(m5(h))
            h = self.relu(m6(h))
            h = m7(h)
            heatmaps.append(h)
        return heatmaps

# ============================================================================
# 内联 util.py (open_pose) - 绘图与检测辅助函数
# ============================================================================

_eps = 0.01

def _smart_resize(x, s):
    Ht, Wt = s
    orig_ndim = x.ndim
    if orig_ndim == 2:
        Ho, Wo = x.shape
        Co = 1
    else:
        Ho, Wo = x.shape[0], x.shape[1]
        Co = int(np.prod(x.shape[2:]))
        if x.ndim > 3:
            x = x.reshape(Ho, Wo, Co)
    if Co == 3 or Co == 1:
        if orig_ndim == 2:
            img = Image.fromarray(x)
        elif Co == 1:
            img = Image.fromarray(x[:, :, 0])
        else:
            img = Image.fromarray(x)
        resampling = Image.Resampling.LANCZOS
        img = img.resize((int(Wt), int(Ht)), resampling)
        result = np.array(img)
        if Co == 1:
            result = result[:, :, None]
        return result
    else:
        return np.concatenate([_smart_resize(x[:, :, i], s) for i in range(Co)], axis=2)


def _smart_resize_k(x, fx, fy):
    orig_ndim = x.ndim
    if orig_ndim == 2:
        Ho, Wo = x.shape
        Co = 1
    else:
        Ho, Wo = x.shape[0], x.shape[1]
        Co = int(np.prod(x.shape[2:]))
        if x.ndim > 3:
            x = x.reshape(Ho, Wo, Co)
    Ht, Wt = int(Ho * fy), int(Wo * fx)
    if Co == 3 or Co == 1:
        if orig_ndim == 2:
            img = Image.fromarray(x)
        elif Co == 1:
            img = Image.fromarray(x[:, :, 0])
        else:
            img = Image.fromarray(x)
        img = img.resize((Wt, Ht), Image.Resampling.LANCZOS)
        result = np.array(img)
        if Co == 1:
            result = result[:, :, None]
        return result
    else:
        return np.concatenate([_smart_resize_k(x[:, :, i], fx, fy) for i in range(Co)], axis=2)

def _pad_right_down_corner(img, stride, padValue):
    h = img.shape[0]
    w = img.shape[1]
    pad = [0, 0, 0, 0]
    pad[2] = 0 if (h % stride == 0) else stride - (h % stride)
    pad[3] = 0 if (w % stride == 0) else stride - (w % stride)
    img_padded = img
    pad_up = np.tile(img_padded[0:1, :, :] * 0 + padValue, (pad[0], 1, 1))
    img_padded = np.concatenate((pad_up, img_padded), axis=0)
    pad_left = np.tile(img_padded[:, 0:1, :] * 0 + padValue, (1, pad[1], 1))
    img_padded = np.concatenate((pad_left, img_padded), axis=1)
    pad_down = np.tile(img_padded[-2:-1, :, :] * 0 + padValue, (pad[2], 1, 1))
    img_padded = np.concatenate((img_padded, pad_down), axis=0)
    pad_right = np.tile(img_padded[:, -2:-1, :] * 0 + padValue, (1, pad[3], 1))
    img_padded = np.concatenate((img_padded, pad_right), axis=1)
    return img_padded, pad

def _transfer(model, model_weights):
    transfered_model_weights = {}
    for weights_name in model.state_dict().keys():
        transfered_model_weights[weights_name] = model_weights['.'.join(weights_name.split('.')[1:])]
    return transfered_model_weights

def _draw_bodypose(canvas, keypoints, xinsr_stick_scaling=False):
    H, W, C = canvas.shape
    stickwidth = 4
    max_side = max(H, W)
    if xinsr_stick_scaling:
        stick_scale = 1 if max_side < 500 else min(2 + (max_side // 1000), 7)
    else:
        stick_scale = 1
    limbSeq = [
        [2, 3], [2, 6], [3, 4], [4, 5],
        [6, 7], [7, 8], [2, 9], [9, 10],
        [10, 11], [2, 12], [12, 13], [13, 14],
        [2, 1], [1, 15], [15, 17], [1, 16], [16, 18],
    ]
    colors = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0],
              [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85],
              [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
              [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
              [255, 0, 170], [255, 0, 85]]
    for (k1_index, k2_index), color in zip(limbSeq, colors):
        keypoint1 = keypoints[k1_index - 1]
        keypoint2 = keypoints[k2_index - 1]
        if keypoint1 is None or keypoint2 is None:
            continue
        Y = np.array([keypoint1.x, keypoint2.x]) * float(W)
        X = np.array([keypoint1.y, keypoint2.y]) * float(H)
        mX = np.mean(X)
        mY = np.mean(Y)
        length = ((X[0] - X[1]) ** 2 + (Y[0] - Y[1]) ** 2) ** 0.5
        angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
        # 用 PIL 绘制椭圆骨架
        pil_img = Image.fromarray(canvas)
        draw = ImageDraw.Draw(pil_img)
        half_len = int(length / 2)
        sw = stickwidth * stick_scale
        cx, cy = int(mY), int(mX)
        # 生成椭圆外接矩形（旋转通过 polygon 近似）
        cos_a = math.cos(math.radians(angle))
        sin_a = math.sin(math.radians(angle))
        pts = []
        for t in range(0, 360, 10):
            rad = math.radians(t)
            dx = half_len * math.cos(rad)
            dy = sw * math.sin(rad)
            rx = dx * cos_a - dy * sin_a
            ry = dx * sin_a + dy * cos_a
            pts.append((cx + rx, cy + ry))
        fill_color = tuple(int(float(c) * 0.6) for c in color)
        draw.polygon(pts, fill=fill_color)
        canvas = np.array(pil_img)
    for keypoint, color in zip(keypoints, colors):
        if keypoint is None:
            continue
        x, y = keypoint.x, keypoint.y
        x = int(x * W)
        y = int(y * H)
        pil_img = Image.fromarray(canvas)
        draw = ImageDraw.Draw(pil_img)
        draw.ellipse([x - 4, y - 4, x + 4, y + 4], fill=tuple(color))
        canvas = np.array(pil_img)
    return canvas

def _draw_handpose(canvas, keypoints):
    if not keypoints:
        return canvas
    H, W, C = canvas.shape
    edges = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
             [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15],
             [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]]
    try:
        import matplotlib.colors as mcolors
        has_mpl = True
    except Exception:
        has_mpl = False
    pil_img = Image.fromarray(canvas)
    draw = ImageDraw.Draw(pil_img)
    for ie, (e1, e2) in enumerate(edges):
        k1 = keypoints[e1]
        k2 = keypoints[e2]
        if k1 is None or k2 is None:
            continue
        x1 = int(k1.x * W)
        y1 = int(k1.y * H)
        x2 = int(k2.x * W)
        y2 = int(k2.y * H)
        if x1 > _eps and y1 > _eps and x2 > _eps and y2 > _eps:
            if has_mpl:
                color = tuple(int(c * 255) for c in mcolors.hsv_to_rgb([ie / float(len(edges)), 1.0, 1.0]))
            else:
                color = (0, 255, 0)
            draw.line([(x1, y1), (x2, y2)], fill=color, width=2)
    for keypoint in keypoints:
        x, y = keypoint.x, keypoint.y
        x = int(x * W)
        y = int(y * H)
        if x > _eps and y > _eps:
            draw.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(0, 0, 255))
    canvas = np.array(pil_img)
    return canvas

def _draw_facepose(canvas, keypoints):
    if not keypoints:
        return canvas
    H, W, C = canvas.shape
    pil_img = Image.fromarray(canvas)
    draw = ImageDraw.Draw(pil_img)
    for keypoint in keypoints:
        x, y = keypoint.x, keypoint.y
        x = int(x * W)
        y = int(y * H)
        if x > _eps and y > _eps:
            draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 255, 255))
    canvas = np.array(pil_img)
    return canvas

def _hand_detect(body, oriImg):
    ratioWristElbow = 0.33
    detect_result = []
    image_height, image_width = oriImg.shape[0:2]
    keypoints = body.keypoints
    left_shoulder = keypoints[5]
    left_elbow = keypoints[6]
    left_wrist = keypoints[7]
    right_shoulder = keypoints[2]
    right_elbow = keypoints[3]
    right_wrist = keypoints[4]
    has_left = all(k is not None for k in (left_shoulder, left_elbow, left_wrist))
    has_right = all(k is not None for k in (right_shoulder, right_elbow, right_wrist))
    if not (has_left or has_right):
        return []
    hands = []
    if has_left:
        hands.append([left_shoulder.x, left_shoulder.y, left_elbow.x, left_elbow.y, left_wrist.x, left_wrist.y, True])
    if has_right:
        hands.append([right_shoulder.x, right_shoulder.y, right_elbow.x, right_elbow.y, right_wrist.x, right_wrist.y, False])
    for x1, y1, x2, y2, x3, y3, is_left in hands:
        x = x3 + ratioWristElbow * (x3 - x2)
        y = y3 + ratioWristElbow * (y3 - y2)
        distanceWristElbow = math.sqrt((x3 - x2) ** 2 + (y3 - y2) ** 2)
        distanceElbowShoulder = math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        width = 1.5 * max(distanceWristElbow, 0.9 * distanceElbowShoulder)
        x -= width / 2
        y -= width / 2
        if x < 0: x = 0
        if y < 0: y = 0
        width1 = width
        width2 = width
        if x + width > image_width: width1 = image_width - x
        if y + width > image_height: width2 = image_height - y
        width = min(width1, width2)
        if width >= 20:
            detect_result.append((int(x), int(y), int(width), is_left))
    return detect_result

def _face_detect(body, oriImg):
    image_height, image_width = oriImg.shape[0:2]
    keypoints = body.keypoints
    head = keypoints[0]
    left_eye = keypoints[14]
    right_eye = keypoints[15]
    left_ear = keypoints[16]
    right_ear = keypoints[17]
    if head is None or all(k is None for k in (left_eye, right_eye, left_ear, right_ear)):
        return None
    width = 0.0
    x0, y0 = head.x, head.y
    if left_eye is not None:
        d = max(abs(x0 - left_eye.x), abs(y0 - left_eye.y))
        width = max(width, d * 3.0)
    if right_eye is not None:
        d = max(abs(x0 - right_eye.x), abs(y0 - right_eye.y))
        width = max(width, d * 3.0)
    if left_ear is not None:
        d = max(abs(x0 - left_ear.x), abs(y0 - left_ear.y))
        width = max(width, d * 1.5)
    if right_ear is not None:
        d = max(abs(x0 - right_ear.x), abs(y0 - right_ear.y))
        width = max(width, d * 1.5)
    x, y = x0, y0
    x -= width
    y -= width
    if x < 0: x = 0
    if y < 0: y = 0
    width1 = width * 2
    width2 = width * 2
    if x + width > image_width: width1 = image_width - x
    if y + width > image_height: width2 = image_height - y
    width = min(width1, width2)
    if width >= 20:
        return int(x), int(y), int(width)
    return None

def _npmax(array):
    arrayindex = array.argmax(1)
    arrayvalue = array.max(1)
    i = arrayvalue.argmax()
    j = arrayindex[i]
    return i, j

# ============================================================================
# 内联 body.py - 身体检测
# ============================================================================

class _Body(object):
    def __init__(self, model_path):
        self.model = _bodypose_model()
        model_dict = _transfer(self.model, torch.load(model_path, map_location='cpu', weights_only=True))
        self.model.load_state_dict(model_dict)
        self.model.eval()
        self.device = "cpu"

    def to(self, device):
        self.model.to(device)
        self.device = device
        return self

    def __call__(self, oriImg):
        scale_search = [0.5]
        boxsize = 368
        stride = 8
        padValue = 128
        thre1 = 0.1
        thre2 = 0.05
        multiplier = [x * boxsize / oriImg.shape[0] for x in scale_search]
        heatmap_avg = np.zeros((oriImg.shape[0], oriImg.shape[1], 19))
        paf_avg = np.zeros((oriImg.shape[0], oriImg.shape[1], 38))
        for m in range(len(multiplier)):
            scale = multiplier[m]
            imageToTest = _smart_resize_k(oriImg, fx=scale, fy=scale)
            imageToTest_padded, pad = _pad_right_down_corner(imageToTest, stride, padValue)
            im = np.transpose(np.float32(imageToTest_padded[:, :, :, np.newaxis]), (3, 2, 0, 1)) / 256 - 0.5
            im = np.ascontiguousarray(im)
            data = torch.from_numpy(im).float().to(self.device)
            with torch.no_grad():
                Mconv7_stage6_L1, Mconv7_stage6_L2 = self.model(data)
            Mconv7_stage6_L1 = Mconv7_stage6_L1.cpu().numpy()
            Mconv7_stage6_L2 = Mconv7_stage6_L2.cpu().numpy()
            heatmap = np.transpose(np.squeeze(Mconv7_stage6_L2), (1, 2, 0))
            heatmap = _smart_resize_k(heatmap, fx=stride, fy=stride)
            heatmap = heatmap[:imageToTest_padded.shape[0] - pad[2], :imageToTest_padded.shape[1] - pad[3], :]
            heatmap = _smart_resize(heatmap, (oriImg.shape[0], oriImg.shape[1]))
            paf = np.transpose(np.squeeze(Mconv7_stage6_L1), (1, 2, 0))
            paf = _smart_resize_k(paf, fx=stride, fy=stride)
            paf = paf[:imageToTest_padded.shape[0] - pad[2], :imageToTest_padded.shape[1] - pad[3], :]
            paf = _smart_resize(paf, (oriImg.shape[0], oriImg.shape[1]))
            heatmap_avg += heatmap / len(multiplier)
            paf_avg += paf / len(multiplier)
        all_peaks = []
        peak_counter = 0
        for part in range(18):
            map_ori = heatmap_avg[:, :, part]
            one_heatmap = gaussian_filter(map_ori, sigma=3)
            map_left = np.zeros(one_heatmap.shape)
            map_left[1:, :] = one_heatmap[:-1, :]
            map_right = np.zeros(one_heatmap.shape)
            map_right[:-1, :] = one_heatmap[1:, :]
            map_up = np.zeros(one_heatmap.shape)
            map_up[:, 1:] = one_heatmap[:, :-1]
            map_down = np.zeros(one_heatmap.shape)
            map_down[:, :-1] = one_heatmap[:, 1:]
            peaks_binary = np.logical_and.reduce(
                (one_heatmap >= map_left, one_heatmap >= map_right,
                 one_heatmap >= map_up, one_heatmap >= map_down, one_heatmap > thre1))
            peaks = list(zip(np.nonzero(peaks_binary)[1], np.nonzero(peaks_binary)[0]))
            peaks_with_score = [x + (map_ori[x[1], x[0]],) for x in peaks]
            peak_id = range(peak_counter, peak_counter + len(peaks))
            peaks_with_score_and_id = [peaks_with_score[i] + (peak_id[i],) for i in range(len(peak_id))]
            all_peaks.append(peaks_with_score_and_id)
            peak_counter += len(peaks)
        limbSeq = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10],
                   [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17],
                   [1, 16], [16, 18], [3, 17], [6, 18]]
        mapIdx = [[31, 32], [39, 40], [33, 34], [35, 36], [41, 42], [43, 44],
                  [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30],
                  [47, 48], [49, 50], [53, 54], [51, 52], [55, 56], [37, 38], [45, 46]]
        connection_all = []
        special_k = []
        mid_num = 10
        for k in range(len(mapIdx)):
            score_mid = paf_avg[:, :, [x - 19 for x in mapIdx[k]]]
            candA = all_peaks[limbSeq[k][0] - 1]
            candB = all_peaks[limbSeq[k][1] - 1]
            nA = len(candA)
            nB = len(candB)
            if (nA != 0 and nB != 0):
                connection_candidate = []
                for i in range(nA):
                    for j in range(nB):
                        vec = np.subtract(candB[j][:2], candA[i][:2])
                        norm = math.sqrt(vec[0] * vec[0] + vec[1] * vec[1])
                        norm = max(0.001, norm)
                        vec = np.divide(vec, norm)
                        startend = list(zip(np.linspace(candA[i][0], candB[j][0], num=mid_num),
                                            np.linspace(candA[i][1], candB[j][1], num=mid_num)))
                        vec_x = np.array([score_mid[int(round(startend[I][1])), int(round(startend[I][0])), 0]
                                          for I in range(len(startend))])
                        vec_y = np.array([score_mid[int(round(startend[I][1])), int(round(startend[I][0])), 1]
                                          for I in range(len(startend))])
                        score_midpts = np.multiply(vec_x, vec[0]) + np.multiply(vec_y, vec[1])
                        score_with_dist_prior = sum(score_midpts) / len(score_midpts) + min(0.5 * oriImg.shape[0] / norm - 1, 0)
                        criterion1 = len(np.nonzero(score_midpts > thre2)[0]) > 0.8 * len(score_midpts)
                        criterion2 = score_with_dist_prior > 0
                        if criterion1 and criterion2:
                            connection_candidate.append([i, j, score_with_dist_prior, score_with_dist_prior + candA[i][2] + candB[j][2]])
                connection_candidate = sorted(connection_candidate, key=lambda x: x[2], reverse=True)
                connection = np.zeros((0, 5))
                for c in range(len(connection_candidate)):
                    i, j, s = connection_candidate[c][0:3]
                    if (i not in connection[:, 3] and j not in connection[:, 4]):
                        connection = np.vstack([connection, [candA[i][3], candB[j][3], s, i, j]])
                        if (len(connection) >= min(nA, nB)):
                            break
                connection_all.append(connection)
            else:
                special_k.append(k)
                connection_all.append([])
        subset = -1 * np.ones((0, 20))
        candidate = np.array([item for sublist in all_peaks for item in sublist])
        for k in range(len(mapIdx)):
            if k not in special_k:
                partAs = connection_all[k][:, 0]
                partBs = connection_all[k][:, 1]
                indexA, indexB = np.array(limbSeq[k]) - 1
                for i in range(len(connection_all[k])):
                    found = 0
                    subset_idx = [-1, -1]
                    for j in range(len(subset)):
                        if subset[j][indexA] == partAs[i] or subset[j][indexB] == partBs[i]:
                            subset_idx[found] = j
                            found += 1
                    if found == 1:
                        j = subset_idx[0]
                        if subset[j][indexB] != partBs[i]:
                            subset[j][indexB] = partBs[i]
                            subset[j][-1] += 1
                            subset[j][-2] += candidate[partBs[i].astype(int), 2] + connection_all[k][i][2]
                    elif found == 2:
                        j1, j2 = subset_idx
                        membership = ((subset[j1] >= 0).astype(int) + (subset[j2] >= 0).astype(int))[:-2]
                        if len(np.nonzero(membership == 2)[0]) == 0:
                            subset[j1][:-2] += (subset[j2][:-2] + 1)
                            subset[j1][-2:] += subset[j2][-2:]
                            subset[j1][-2] += connection_all[k][i][2]
                            subset = np.delete(subset, j2, 0)
                        else:
                            subset[j1][indexB] = partBs[i]
                            subset[j1][-1] += 1
                            subset[j1][-2] += candidate[partBs[i].astype(int), 2] + connection_all[k][i][2]
                    elif not found and k < 17:
                        row = -1 * np.ones(20)
                        row[indexA] = partAs[i]
                        row[indexB] = partBs[i]
                        row[-1] = 2
                        row[-2] = sum(candidate[connection_all[k][i, :2].astype(int), 2]) + connection_all[k][i][2]
                        subset = np.vstack([subset, row])
        deleteIdx = []
        for i in range(len(subset)):
            if subset[i][-1] < 4 or subset[i][-2] / subset[i][-1] < 0.4:
                deleteIdx.append(i)
        subset = np.delete(subset, deleteIdx, axis=0)
        return candidate, subset

    @staticmethod
    def format_body_result(candidate, subset):
        return [
            BodyResult(
                keypoints=[
                    Keypoint(x=candidate[ci][0], y=candidate[ci][1],
                             score=candidate[ci][2], id=candidate[ci][3])
                    if ci != -1 else None
                    for ci in person[:18].astype(int)
                ],
                total_score=person[18],
                total_parts=person[19]
            )
            for person in subset
        ]

# ============================================================================
# 内联 hand.py - 手部检测
# ============================================================================

class _Hand(object):
    def __init__(self, model_path):
        self.model = _handpose_model()
        model_dict = _transfer(self.model, torch.load(model_path, map_location='cpu', weights_only=True))
        self.model.load_state_dict(model_dict)
        self.model.eval()
        self.device = "cpu"

    def to(self, device):
        self.model.to(device)
        self.device = device
        return self

    def __call__(self, oriImgRaw):
        scale_search = [0.5, 1.0, 1.5, 2.0]
        boxsize = 368
        stride = 8
        padValue = 128
        thre = 0.05
        multiplier = [x * boxsize for x in scale_search]
        wsize = 128
        heatmap_avg = np.zeros((wsize, wsize, 22))
        Hr, Wr, Cr = oriImgRaw.shape
        oriImg = gaussian_filter(oriImgRaw, sigma=(0.8, 0.8, 0))
        for m in range(len(multiplier)):
            scale = multiplier[m]
            imageToTest = _smart_resize(oriImg, (scale, scale))
            imageToTest_padded, pad = _pad_right_down_corner(imageToTest, stride, padValue)
            im = np.transpose(np.float32(imageToTest_padded[:, :, :, np.newaxis]), (3, 2, 0, 1)) / 256 - 0.5
            im = np.ascontiguousarray(im)
            data = torch.from_numpy(im).float().to(self.device)
            with torch.no_grad():
                output = self.model(data).cpu().numpy()
            heatmap = np.transpose(np.squeeze(output), (1, 2, 0))
            heatmap = _smart_resize_k(heatmap, fx=stride, fy=stride)
            heatmap = heatmap[:imageToTest_padded.shape[0] - pad[2], :imageToTest_padded.shape[1] - pad[3], :]
            heatmap = _smart_resize(heatmap, (wsize, wsize))
            heatmap_avg += heatmap / len(multiplier)
        all_peaks = []
        for part in range(21):
            map_ori = heatmap_avg[:, :, part]
            one_heatmap = gaussian_filter(map_ori, sigma=3)
            binary = np.ascontiguousarray(one_heatmap > thre, dtype=np.uint8)
            if np.sum(binary) == 0:
                all_peaks.append([0, 0])
                continue
            label_img, label_numbers = _label_components(binary)
            max_index = np.argmax([np.sum(map_ori[label_img == i]) for i in range(1, label_numbers + 1)]) + 1
            label_img[label_img != max_index] = 0
            map_ori[label_img == 0] = 0
            y, x = _npmax(map_ori)
            y = int(float(y) * float(Hr) / float(wsize))
            x = int(float(x) * float(Wr) / float(wsize))
            all_peaks.append([x, y])
        return np.array(all_peaks)

# ============================================================================
# 内联 face.py - 面部检测
# ============================================================================

class _Face(object):
    def __init__(self, face_model_path, inference_size=None, gaussian_sigma=None, heatmap_peak_thresh=None):
        self.inference_size = inference_size or 736
        self.sigma = gaussian_sigma or 2.5
        self.threshold = heatmap_peak_thresh or 0.1
        self.model = _FaceNet()
        self.model.load_state_dict(torch.load(face_model_path, map_location='cpu', weights_only=True))
        self.model.eval()
        self.device = "cpu"

    def to(self, device):
        self.model.to(device)
        self.device = device
        return self

    def __call__(self, face_img):
        H, W, C = face_img.shape
        w_size = 384
        x_data = torch.from_numpy(_smart_resize(face_img, (w_size, w_size))).permute([2, 0, 1]) / 256.0 - 0.5
        x_data = x_data.to(self.device)
        with torch.no_grad():
            hs = self.model(x_data[None, ...])
            heatmaps = F.interpolate(hs[-1], (H, W), mode='bilinear', align_corners=True).cpu().numpy()[0]
        return heatmaps

    def compute_peaks_from_heatmaps(self, heatmaps):
        all_peaks = []
        for part in range(heatmaps.shape[0]):
            map_ori = heatmaps[part].copy()
            binary = np.ascontiguousarray(map_ori > 0.05, dtype=np.uint8)
            if np.sum(binary) == 0:
                continue
            positions = np.where(binary > 0.5)
            intensities = map_ori[positions]
            mi = np.argmax(intensities)
            y, x = positions[0][mi], positions[1][mi]
            all_peaks.append([x, y])
        return np.array(all_peaks)

# ============================================================================
# 内联 OpenposeDetector
# ============================================================================

def _draw_poses(poses, H, W, draw_body=True, draw_hand=True, draw_face=True, xinsr_stick_scaling=False):
    canvas = np.zeros(shape=(H, W, 3), dtype=np.uint8)
    for pose in poses:
        if draw_body:
            canvas = _draw_bodypose(canvas, pose.body.keypoints, xinsr_stick_scaling)
        if draw_hand:
            canvas = _draw_handpose(canvas, pose.left_hand)
            canvas = _draw_handpose(canvas, pose.right_hand)
        if draw_face:
            canvas = _draw_facepose(canvas, pose.face)
    return canvas

def _encode_poses_as_dict(poses, canvas_height, canvas_width):
    def compress_keypoints(keypoints):
        if not keypoints:
            return None
        return [value for keypoint in keypoints for value in (
            [float(keypoint.x), float(keypoint.y), 1.0] if keypoint is not None else [0.0, 0.0, 0.0]
        )]
    return {
        'people': [{
            'pose_keypoints_2d': compress_keypoints(pose.body.keypoints),
            "face_keypoints_2d": compress_keypoints(pose.face),
            "hand_left_keypoints_2d": compress_keypoints(pose.left_hand),
            "hand_right_keypoints_2d": compress_keypoints(pose.right_hand),
        } for pose in poses],
        'canvas_height': canvas_height,
        'canvas_width': canvas_width,
    }

class _OpenposeDetector:
    def __init__(self, body_estimation, hand_estimation=None, face_estimation=None):
        self.body_estimation = body_estimation
        self.hand_estimation = hand_estimation
        self.face_estimation = face_estimation

    def to(self, device):
        self.body_estimation.to(device)
        if self.hand_estimation:
            self.hand_estimation.to(device)
        if self.face_estimation:
            self.face_estimation.to(device)
        return self

    def detect_hands(self, body, oriImg):
        left_hand = None
        right_hand = None
        H, W, _ = oriImg.shape
        for x, y, w, is_left in _hand_detect(body, oriImg):
            peaks = self.hand_estimation(oriImg[y:y+w, x:x+w, :]).astype(np.float32)
            if peaks.ndim == 2 and peaks.shape[1] == 2:
                peaks[:, 0] = np.where(peaks[:, 0] < 1e-6, -1, peaks[:, 0] + x) / float(W)
                peaks[:, 1] = np.where(peaks[:, 1] < 1e-6, -1, peaks[:, 1] + y) / float(H)
                hand_result = [Keypoint(x=peak[0], y=peak[1]) for peak in peaks]
                if is_left:
                    left_hand = hand_result
                else:
                    right_hand = hand_result
        return left_hand, right_hand

    def detect_face(self, body, oriImg):
        face = _face_detect(body, oriImg)
        if face is None:
            return None
        x, y, w = face
        H, W, _ = oriImg.shape
        heatmaps = self.face_estimation(oriImg[y:y+w, x:x+w, :])
        peaks = self.face_estimation.compute_peaks_from_heatmaps(heatmaps).astype(np.float32)
        if peaks.ndim == 2 and peaks.shape[1] == 2:
            peaks[:, 0] = np.where(peaks[:, 0] < 1e-6, -1, peaks[:, 0] + x) / float(W)
            peaks[:, 1] = np.where(peaks[:, 1] < 1e-6, -1, peaks[:, 1] + y) / float(H)
            return [Keypoint(x=peak[0], y=peak[1]) for peak in peaks]
        return None

    def detect_poses(self, oriImg, include_hand=False, include_face=False):
        oriImg = oriImg[:, :, ::-1].copy()
        H, W, C = oriImg.shape
        with torch.no_grad():
            candidate, subset = self.body_estimation(oriImg)
            bodies = self.body_estimation.format_body_result(candidate, subset)
            results = []
            for body in bodies:
                left_hand, right_hand, face = (None,) * 3
                if include_hand:
                    left_hand, right_hand = self.detect_hands(body, oriImg)
                if include_face:
                    face = self.detect_face(body, oriImg)
                results.append(PoseResult(
                    BodyResult(
                        keypoints=[Keypoint(x=kp.x / float(W), y=kp.y / float(H)) if kp is not None else None for kp in body.keypoints],
                        total_score=body.total_score, total_parts=body.total_parts
                    ), left_hand, right_hand, face))
            return results

    def __call__(self, input_image, detect_resolution=512, include_body=True, include_hand=False, include_face=False, output_type="np", image_and_json=False, xinsr_stick_scaling=False, **kwargs):
        input_image, remove_pad = _resize_image_with_pad(input_image, detect_resolution)
        poses = self.detect_poses(input_image, include_hand=include_hand, include_face=include_face)
        canvas = _draw_poses(poses, input_image.shape[0], input_image.shape[1],
                             draw_body=include_body, draw_hand=include_hand, draw_face=include_face,
                             xinsr_stick_scaling=xinsr_stick_scaling)
        detected_map = _HWC3(remove_pad(canvas))
        if output_type == "pil":
            from PIL import Image
            detected_map = Image.fromarray(detected_map)
        if image_and_json:
            return detected_map, _encode_poses_as_dict(poses, detected_map.shape[0], detected_map.shape[1])
        return detected_map

# ============================================================================
# 内联辅助函数（来自 custom_controlnet_aux.util）
# ============================================================================

def _HWC3(x):
    assert x.dtype == np.uint8
    if x.ndim == 2:
        x = x[:, :, None]
    assert x.ndim == 3
    H, W, C = x.shape
    assert C == 1 or C == 3 or C == 4
    if C == 3:
        return x
    if C == 1:
        return np.concatenate([x, x, x], axis=2)
    if C == 4:
        color = x[:, :, 0:3].astype(np.float32)
        alpha = x[:, :, 3:4].astype(np.float32) / 255.0
        y = color * alpha + 255.0 * (1.0 - alpha)
        y = y.clip(0, 255).astype(np.uint8)
        return y

def _pad64(x):
    return int(np.ceil(float(x) / 64.0) * 64 - x)

def _safer_memory(x):
    return np.ascontiguousarray(x.copy()).copy()

def _resize_image_with_pad(input_image, resolution, mode='edge'):
    img = _HWC3(input_image)
    H_raw, W_raw, _ = img.shape
    if resolution == 0:
        return img, lambda x: x
    k = float(resolution) / float(min(H_raw, W_raw))
    H_target = int(np.round(float(H_raw) * k))
    W_target = int(np.round(float(W_raw) * k))
    pil_img = Image.fromarray(img)
    pil_img = pil_img.resize((W_target, H_target), Image.Resampling.LANCZOS)
    img = np.array(pil_img)
    H_pad, W_pad = _pad64(H_target), _pad64(W_target)
    img_padded = np.pad(img, [[0, H_pad], [0, W_pad], [0, 0]], mode=mode)

    def remove_pad(x):
        return _safer_memory(x[:H_target, :W_target, ...])

    return _safer_memory(img_padded), remove_pad

# ============================================================================
# 模型路径查找与下载
# ============================================================================

def _find_model_dir():
    """查找模型文件目录，优先使用已有模型。"""
    possible_paths = [
        os.path.join(os.path.dirname(__file__), '..', '..', 'comfyui_controlnet_aux', 'ckpts', 'lllyasviel', 'Annotators'),
        os.path.join(os.path.dirname(__file__), '..', '..', '..', 'comfyui_controlnet_aux', 'ckpts', 'lllyasviel', 'Annotators'),
        os.path.join(folder_paths.base_path, 'custom_nodes', 'comfyui_controlnet_aux', 'ckpts', 'lllyasviel', 'Annotators'),
        os.path.join(os.path.dirname(__file__), '..', 'ckpts', 'openpose'),
        os.path.join(os.path.dirname(__file__), '..', 'models', 'openpose'),
    ]
    for path in possible_paths:
        abs_path = os.path.abspath(path)
        body_path = os.path.join(abs_path, 'body_pose_model.pth')
        if os.path.exists(body_path):
            return abs_path
    return None

def _download_model(filename, dest_dir):
    """下载模型文件，使用 huggingface_hub（懒加载）。"""
    model_path = os.path.join(dest_dir, filename)
    if os.path.exists(model_path):
        return model_path

    os.makedirs(dest_dir, exist_ok=True)

    repo_map = {
        'body_pose_model.pth': ('lllyasviel/Annotators', 'body_pose_model.pth'),
        'hand_pose_model.pth': ('lllyasviel/Annotators', 'hand_pose_model.pth'),
        'facenet.pth': ('lllyasviel/Annotators', 'facenet.pth'),
    }

    if filename not in repo_map:
        raise RuntimeError(f"未知的模型文件: {filename}")

    repo_id, repo_filename = repo_map[filename]

    try:
        from huggingface_hub import hf_hub_download
        print(f"[GJJ] 正在下载 OpenPose 模型: {filename}")
        downloaded = hf_hub_download(
            repo_id=repo_id,
            filename=repo_filename,
            local_dir=dest_dir,
            local_dir_use_symlinks=False,
            resume_download=True,
        )
        return downloaded
    except ImportError:
        raise RuntimeError(
            f"未找到 huggingface_hub 库，无法自动下载模型。\n"
            f"请手动下载模型文件到: {dest_dir}\n"
            f"  - https://huggingface.co/lllyasviel/Annotators/resolve/main/body_pose_model.pth\n"
            f"  - https://huggingface.co/lllyasviel/Annotators/resolve/main/hand_pose_model.pth\n"
            f"  - https://huggingface.co/lllyasviel/Annotators/resolve/main/facenet.pth\n"
            f"或安装 huggingface_hub: pip install huggingface-hub"
        )
    except Exception as e:
        raise RuntimeError(f"下载模型 {filename} 失败: {e}")

def _load_openpose_model(device):
    """加载 OpenPose 模型，自动查找或下载。"""
    model_dir = _find_model_dir()
    if model_dir is None:
        model_dir = os.path.join(os.path.dirname(__file__), '..', 'ckpts', 'openpose')
        os.makedirs(model_dir, exist_ok=True)

    body_path = os.path.join(model_dir, 'body_pose_model.pth')
    hand_path = os.path.join(model_dir, 'hand_pose_model.pth')
    face_path = os.path.join(model_dir, 'facenet.pth')

    missing = []
    if not os.path.exists(body_path):
        missing.append('body_pose_model.pth')
    if not os.path.exists(hand_path):
        missing.append('hand_pose_model.pth')
    if not os.path.exists(face_path):
        missing.append('facenet.pth')

    if missing:
        print(f"[GJJ] OpenPose 缺少模型文件: {', '.join(missing)}，尝试下载...")
        for fname in missing:
            _download_model(fname, model_dir)

    body_est = _Body(body_path)
    hand_est = _Hand(hand_path)
    face_est = _Face(face_path)

    detector = _OpenposeDetector(body_est, hand_est, face_est)
    detector.to(device)
    return detector

# ============================================================================
# GJJ 节点定义
# ============================================================================

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

class GJJ_OpenPose:
    """
    🦴 OpenPose 姿态检测节点
    检测图像中的人体姿态、手部和面部关键点，输出姿态骨架图。
    支持单张图片和批量图片处理，自动查找或下载模型文件。
    """

    DESCRIPTION = (
        "检测图像中的人体姿态、手部和面部关键点，输出 OpenPose 风格骨架图。\n\n"
        "功能特点：\n"
        "  • 身体关键点检测（18个关键点：头部、肩膀、手肘、手腕、臀部、膝盖、脚踝等）\n"
        "  • 手部关键点检测（21个关键点/每只手）\n"
        "  • 面部关键点检测（70个关键点）\n"
        "  • 支持单张图片和批量图片输入\n"
        "  • 自动缩放检测分辨率以平衡速度与精度\n"
        "  • 支持 xinsir/controlnet-openpose-sdxl-1.0 骨架线条缩放\n\n"
        "输出为 RGB 姿态骨架图，可直接用于 ControlNet 等后续处理。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("GJJ_BATCH_IMAGE,IMAGE", {
                    "display_name": "输入图像",
                    "tooltip": "输入图像（支持普通 IMAGE 或 GJJ 批量图片），自动合并批次处理",
                }),
                "detect_hand": (["启用", "禁用"], {
                    "default": "启用",
                    "display_name": "检测手部",
                    "tooltip": "启用后检测双手 21 个关键点（手腕、拇指、食指、中指、无名指、小指各关节）",
                }),
                "detect_body": (["启用", "禁用"], {
                    "default": "启用",
                    "display_name": "检测身体",
                    "tooltip": "启用后检测身体 18 个关键点（鼻子、颈部、肩膀、手肘、手腕、臀部、膝盖、脚踝）",
                }),
                "detect_face": (["启用", "禁用"], {
                    "default": "启用",
                    "display_name": "检测面部",
                    "tooltip": "启用后检测面部 70 个关键点（眉毛、眼睛、鼻子、嘴唇、面部轮廓）",
                }),
                "resolution": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 16384,
                    "step": 64,
                    "display_name": "检测分辨率",
                    "tooltip": "检测时使用的分辨率（短边缩放到此值）。越大精度越高但越慢，建议 512~1024",
                }),
                "xinsr_stick_scaling": (["禁用", "启用"], {
                    "default": "禁用",
                    "display_name": "骨架线条缩放",
                    "tooltip": "为 xinsir/controlnet-openpose-sdxl-1.0 模型缩放骨架线条宽度，大图时自动加粗线条",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("姿态骨架图",)
    OUTPUT_TOOLTIPS = ("OpenPose 姿态骨架图（RGB），黑色背景上绘制彩色骨架线条",)
    FUNCTION = "estimate_pose"
    CATEGORY = "GJJ/图像"

    def estimate_pose(self, images, detect_hand="启用", detect_body="启用", detect_face="启用", resolution=512, xinsr_stick_scaling="禁用", unique_id=None, extra_pnginfo=None, **kwargs):
        device = model_management.get_torch_device()

        include_hand = detect_hand == "启用"
        include_body = detect_body == "启用"
        include_face = detect_face == "启用"
        use_xinsr = xinsr_stick_scaling == "启用"

        if images is None:
            raise RuntimeError("至少需要连接一张输入图片。")
        if not isinstance(images, torch.Tensor):
            raise RuntimeError("输入图片类型错误。")
        if images.ndim == 3:
            images = images.unsqueeze(0)
        if images.ndim != 4:
            raise RuntimeError("输入图片维度错误，需要 (B, H, W, C) 格式。")

        merged = images
        batch_size = merged.shape[0]

        try:
            detector = _load_openpose_model(device)
        except Exception as e:
            raise RuntimeError(
                f"加载 OpenPose 模型失败。\n"
                f"请确保模型文件存在或网络可访问 HuggingFace。\n"
                f"错误详情: {e}"
            ) from e

        pbar = comfy.utils.ProgressBar(batch_size)
        out_tensors = []

        for i in range(batch_size):
            np_image = np.asarray(merged[i].cpu() * 255., dtype=np.uint8)
            pose_result = detector(
                np_image,
                detect_resolution=resolution,
                include_body=include_body,
                include_hand=include_hand,
                include_face=include_face,
                output_type="np",
                xinsr_stick_scaling=use_xinsr,
            )
            out_tensor = torch.from_numpy(pose_result.astype(np.float32) / 255.0)
            out_tensors.append(out_tensor)
            pbar.update(1)

        result = torch.stack(out_tensors, dim=0)
        return (result,)


NODE_CLASS_MAPPINGS["GJJ_OpenPose"] = GJJ_OpenPose
NODE_DISPLAY_NAME_MAPPINGS["GJJ_OpenPose"] = "🦴 OpenPose 姿态检测"
