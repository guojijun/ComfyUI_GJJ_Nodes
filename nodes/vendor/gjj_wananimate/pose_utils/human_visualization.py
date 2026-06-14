# Copyright 2024-2025 The Alibaba Wan Team Authors. All rights reserved.
import os
import cv2
import time
import math
import colorsys
import numpy as np
from typing import Dict, List
import random
from .pose2d_utils import AAPoseMeta


def _hsv_rgb255(hue, saturation=1.0, value=1.0):
    r, g, b = colorsys.hsv_to_rgb(float(hue), float(saturation), float(value))
    return np.array([r, g, b], dtype=np.float32) * 255.0


def draw_handpose(canvas, keypoints, hand_score_th=0.6):
    """
    Draw keypoints and connections representing hand pose on a given canvas.

    Args:
        canvas (np.ndarray): A 3D numpy array representing the canvas (image) on which to draw the hand pose.
        keypoints (List[Keypoint]| None): A list of Keypoint objects representing the hand keypoints to be drawn
                                          or None if no keypoints are present.

    Returns:
        np.ndarray: A 3D numpy array representing the modified canvas with the drawn hand pose.

    Note:
        The function expects the x and y coordinates of the keypoints to be normalized between 0 and 1.
    """
    eps = 0.01

    H, W, C = canvas.shape
    stickwidth = max(int(min(H, W) / 200), 1)

    edges = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [0, 5],
        [5, 6],
        [6, 7],
        [7, 8],
        [0, 9],
        [9, 10],
        [10, 11],
        [11, 12],
        [0, 13],
        [13, 14],
        [14, 15],
        [15, 16],
        [0, 17],
        [17, 18],
        [18, 19],
        [19, 20],
    ]

    for ie, (e1, e2) in enumerate(edges):
        k1 = keypoints[e1]
        k2 = keypoints[e2]
        if k1 is None or k2 is None:
            continue
        if k1[2] < hand_score_th or k2[2] < hand_score_th:
            continue

        x1 = int(k1[0])
        y1 = int(k1[1])
        x2 = int(k2[0])
        y2 = int(k2[1])
        if x1 > eps and y1 > eps and x2 > eps and y2 > eps:
            cv2.line(
                canvas,
                (x1, y1),
                (x2, y2),
                _hsv_rgb255(ie / float(len(edges))),
                thickness=stickwidth,
            )

    for keypoint in keypoints:

        if keypoint is None:
            continue
        if keypoint[2] < hand_score_th:
            continue

        x, y = keypoint[0], keypoint[1]
        x = int(x)
        y = int(y)
        if x > eps and y > eps:
            cv2.circle(canvas, (x, y), stickwidth, (0, 0, 255), thickness=-1)
    return canvas


def draw_handpose_new(canvas, keypoints, stickwidth_type='v2', hand_score_th=0.6, hand_stick_width=4):
    """
    Draw keypoints and connections representing hand pose on a given canvas.

    Args:
        canvas (np.ndarray): A 3D numpy array representing the canvas (image) on which to draw the hand pose.
        keypoints (List[Keypoint]| None): A list of Keypoint objects representing the hand keypoints to be drawn
                                          or None if no keypoints are present.

    Returns:
        np.ndarray: A 3D numpy array representing the modified canvas with the drawn hand pose.

    Note:
        The function expects the x and y coordinates of the keypoints to be normalized between 0 and 1.
    """
    eps = 0.01

    H, W, C = canvas.shape
    # if stickwidth_type == 'v1':
    #     stickwidth = max(int(min(H, W) / 200), 1)
    # elif stickwidth_type == 'v2':
    #     stickwidth = max(max(int(min(H, W) / 200) - 1, 1) // 2, 1)
    if hand_stick_width == -1:
        stickwidth = max(max(int(min(H, W) / 200) - 1, 1) // 2, 1)
    else:
        stickwidth = hand_stick_width

    edges = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [0, 5],
        [5, 6],
        [6, 7],
        [7, 8],
        [0, 9],
        [9, 10],
        [10, 11],
        [11, 12],
        [0, 13],
        [13, 14],
        [14, 15],
        [15, 16],
        [0, 17],
        [17, 18],
        [18, 19],
        [19, 20],
    ]

    for ie, (e1, e2) in enumerate(edges):
        k1 = keypoints[e1]
        k2 = keypoints[e2]
        if k1 is None or k2 is None:
            continue
        if k1[2] < hand_score_th or k2[2] < hand_score_th:
            continue

        x1 = int(k1[0])
        y1 = int(k1[1])
        x2 = int(k2[0])
        y2 = int(k2[1])
        if x1 > eps and y1 > eps and x2 > eps and y2 > eps:
            cv2.line(
                canvas,
                (x1, y1),
                (x2, y2),
                _hsv_rgb255(ie / float(len(edges))),
                thickness=stickwidth,
            )

    for keypoint in keypoints:

        if keypoint is None:
            continue
        if keypoint[2] < hand_score_th:
            continue

        x, y = keypoint[0], keypoint[1]
        x = int(x)
        y = int(y)
        if x > eps and y > eps:
            cv2.circle(canvas, (x, y), stickwidth, (0, 0, 255), thickness=-1)
    return canvas


def draw_ellipse_by_2kp(img, keypoint1, keypoint2, color, threshold=0.6):
    H, W, C = img.shape
    stickwidth = max(int(min(H, W) / 200), 1)

    if keypoint1[-1] < threshold or keypoint2[-1] < threshold:
        return img

    Y = np.array([keypoint1[0], keypoint2[0]])
    X = np.array([keypoint1[1], keypoint2[1]])
    mX = np.mean(X)
    mY = np.mean(Y)
    length = ((X[0] - X[1]) ** 2 + (Y[0] - Y[1]) ** 2) ** 0.5
    angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
    polygon = cv2.ellipse2Poly((int(mY), int(mX)), (int(length / 2), stickwidth), int(angle), 0, 360, 1)
    cv2.fillConvexPoly(img, polygon, [int(float(c) * 0.6) for c in color])
    return img


def split_pose2d_kps_to_aa(kp2ds: np.ndarray) -> List[np.ndarray]:
    """Convert the 133 keypoints from pose2d to body and hands keypoints.

    Args:
        kp2ds (np.ndarray): [133, 2]

    Returns:
        List[np.ndarray]: _description_
    """
    kp2ds_body = (
        kp2ds[[0, 6, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 17, 20]]
        + kp2ds[[0, 5, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 18, 21]]
    ) / 2
    kp2ds_lhand = kp2ds[91:112]
    kp2ds_rhand = kp2ds[112:133]
    return kp2ds_body.copy(), kp2ds_lhand.copy(), kp2ds_rhand.copy()


def draw_aapose_by_meta(img, meta: AAPoseMeta, threshold=0.5, stick_width_norm=200, draw_hand=True, draw_head=True):
    kp2ds = np.concatenate([meta.kps_body, meta.kps_body_p[:, None]], axis=1)
    kp2ds_lhand = np.concatenate([meta.kps_lhand, meta.kps_lhand_p[:, None]], axis=1)
    kp2ds_rhand = np.concatenate([meta.kps_rhand, meta.kps_rhand_p[:, None]], axis=1)
    pose_img = draw_aapose(img, kp2ds, threshold, kp2ds_lhand=kp2ds_lhand, kp2ds_rhand=kp2ds_rhand, stick_width_norm=stick_width_norm, draw_hand=draw_hand, draw_head=draw_head)
    return pose_img

def draw_aapose_by_meta_new(img, meta: AAPoseMeta, threshold=0.5, stickwidth_type='v2', body_stick_width=-1, draw_hand=True, draw_head=True, hand_stick_width=4):
    kp2ds = np.concatenate([meta.kps_body, meta.kps_body_p[:, None]], axis=1)
    kp2ds_lhand = np.concatenate([meta.kps_lhand, meta.kps_lhand_p[:, None]], axis=1)
    kp2ds_rhand = np.concatenate([meta.kps_rhand, meta.kps_rhand_p[:, None]], axis=1)
    pose_img = draw_aapose_new(img, kp2ds, threshold, kp2ds_lhand=kp2ds_lhand, kp2ds_rhand=kp2ds_rhand, body_stick_width=body_stick_width,
                               stickwidth_type=stickwidth_type, draw_hand=draw_hand, draw_head=draw_head, hand_stick_width=hand_stick_width)
    return pose_img

def draw_hand_by_meta(img, meta: AAPoseMeta, threshold=0.5, stick_width_norm=200):
    kp2ds = np.concatenate([meta.kps_body, meta.kps_body_p[:, None] * 0], axis=1)
    kp2ds_lhand = np.concatenate([meta.kps_lhand, meta.kps_lhand_p[:, None]], axis=1)
    kp2ds_rhand = np.concatenate([meta.kps_rhand, meta.kps_rhand_p[:, None]], axis=1)
    pose_img = draw_aapose(img, kp2ds, threshold, kp2ds_lhand=kp2ds_lhand, kp2ds_rhand=kp2ds_rhand, stick_width_norm=stick_width_norm, draw_hand=True, draw_head=False)
    return pose_img


def draw_aaface_by_meta(img, meta: AAPoseMeta, threshold=0.5, stick_width_norm=200, draw_hand=False, draw_head=True):
    kp2ds = np.concatenate([meta.kps_body, meta.kps_body_p[:, None]], axis=1)
    # kp2ds_lhand = np.concatenate([meta.kps_lhand, meta.kps_lhand_p[:, None]], axis=1)
    # kp2ds_rhand = np.concatenate([meta.kps_rhand, meta.kps_rhand_p[:, None]], axis=1)
    pose_img = draw_M(img, kp2ds, threshold, kp2ds_lhand=None, kp2ds_rhand=None, stick_width_norm=stick_width_norm, draw_hand=draw_hand, draw_head=draw_head)
    return pose_img


def draw_aanose_by_meta(img, meta: AAPoseMeta, threshold=0.5, stick_width_norm=100, draw_hand=False):
    kp2ds = np.concatenate([meta.kps_body, meta.kps_body_p[:, None]], axis=1)
    # kp2ds_lhand = np.concatenate([meta.kps_lhand, meta.kps_lhand_p[:, None]], axis=1)
    # kp2ds_rhand = np.concatenate([meta.kps_rhand, meta.kps_rhand_p[:, None]], axis=1)
    pose_img = draw_nose(img, kp2ds, threshold, kp2ds_lhand=None, kp2ds_rhand=None, stick_width_norm=stick_width_norm, draw_hand=draw_hand)
    return pose_img


def gen_face_motion_seq(img, metas: List[AAPoseMeta], threshold=0.5, stick_width_norm=200):

    return


def draw_M(
    img,
    kp2ds,
    threshold=0.6,
    data_to_json=None,
    idx=-1,
    kp2ds_lhand=None,
    kp2ds_rhand=None,
    draw_hand=False,
    stick_width_norm=200,
    draw_head=True
):
    """
    Draw keypoints and connections representing hand pose on a given canvas.

    Args:
        canvas (np.ndarray): A 3D numpy array representing the canvas (image) on which to draw the hand pose.
        keypoints (List[Keypoint]| None): A list of Keypoint objects representing the hand keypoints to be drawn
                                          or None if no keypoints are present.

    Returns:
        np.ndarray: A 3D numpy array representing the modified canvas with the drawn hand pose.

    Note:
        The function expects the x and y coordinates of the keypoints to be normalized between 0 and 1.
    """

    new_kep_list = [
        "Nose",
        "Neck",
        "RShoulder",
        "RElbow",
        "RWrist",  # No.4
        "LShoulder",
        "LElbow",
        "LWrist",  # No.7
        "RHip",
        "RKnee",
        "RAnkle",  # No.10
        "LHip",
        "LKnee",
        "LAnkle",  # No.13
        "REye",
        "LEye",
        "REar",
        "LEar",
        "LToe",
        "RToe",
    ]
    # kp2ds_body = (kp2ds.copy()[[0, 6, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 17, 20]] + \
    #              kp2ds.copy()[[0, 5, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 18, 21]]) / 2
    kp2ds = kp2ds.copy()
    # import ipdb; ipdb.set_trace()
    kp2ds[[1,2,3,4,5,6,7,8,9,10,11,12,13,18,19], 2] = 0
    if not draw_head:
        kp2ds[[0,14,15,16,17], 2] = 0
    kp2ds_body = kp2ds
    # kp2ds_body = kp2ds_body[:18]

    # kp2ds_lhand = kp2ds.copy()[91:112]
    # kp2ds_rhand = kp2ds.copy()[112:133]

    limbSeq = [
        # [2, 3],
        # [2, 6],  # shoulders
        # [3, 4],
        # [4, 5],  # left arm
        # [6, 7],
        # [7, 8],  # right arm
        # [2, 9],
        # [9, 10],
        # [10, 11],  # right leg
        # [2, 12],
        # [12, 13],
        # [13, 14],  # left leg
        # [2, 1],
        [1, 15],
        [15, 17],
        [1, 16],
        [16, 18],  # face (nose, eyes, ears)
        # [14, 19],
        # [11, 20],  # foot
    ]

    colors = [
        # [255, 0, 0],
        # [255, 85, 0],
        # [255, 170, 0],
        # [255, 255, 0],
        # [170, 255, 0],
        # [85, 255, 0],
        # [0, 255, 0],
        # [0, 255, 85],
        # [0, 255, 170],
        # [0, 255, 255],
        # [0, 170, 255],
        # [0, 85, 255],
        # [0, 0, 255],
        # [85, 0, 255],
        [170, 0, 255],
        [255, 0, 255],
        [255, 0, 170],
        [255, 0, 85],
        # foot
        # [200, 200, 0],
        # [100, 100, 0],
    ]

    H, W, C = img.shape
    stickwidth = max(int(min(H, W) / stick_width_norm), 1)

    for _idx, ((k1_index, k2_index), color) in enumerate(zip(limbSeq, colors)):
        keypoint1 = kp2ds_body[k1_index - 1]
        keypoint2 = kp2ds_body[k2_index - 1]

        if keypoint1[-1] < threshold or keypoint2[-1] < threshold:
            continue

        Y = np.array([keypoint1[0], keypoint2[0]])
        X = np.array([keypoint1[1], keypoint2[1]])
        mX = np.mean(X)
        mY = np.mean(Y)
        length = ((X[0] - X[1]) ** 2 + (Y[0] - Y[1]) ** 2) ** 0.5
        angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
        polygon = cv2.ellipse2Poly((int(mY), int(mX)), (int(length / 2), stickwidth), int(angle), 0, 360, 1)
        cv2.fillConvexPoly(img, polygon, [int(float(c) * 0.6) for c in color])

    for _idx, (keypoint, color) in enumerate(zip(kp2ds_body, colors)):
        if keypoint[-1] < threshold:
            continue
        x, y = keypoint[0], keypoint[1]
        # cv2.circle(canvas, (int(x), int(y)), 4, color, thickness=-1)
        cv2.circle(img, (int(x), int(y)), stickwidth, color, thickness=-1)

    if draw_hand:
        img = draw_handpose(img, kp2ds_lhand, hand_score_th=threshold)
        img = draw_handpose(img, kp2ds_rhand, hand_score_th=threshold)

    kp2ds_body[:, 0] /= W
    kp2ds_body[:, 1] /= H

    if data_to_json is not None:
        if idx == -1:
            data_to_json.append(
                {
                    "image_id": "frame_{:05d}.jpg".format(len(data_to_json) + 1),
                    "height": H,
                    "width": W,
                    "category_id": 1,
                    "keypoints_body": kp2ds_body.tolist(),
                    "keypoints_left_hand": kp2ds_lhand.tolist(),
                    "keypoints_right_hand": kp2ds_rhand.tolist(),
                }
            )
        else:
            data_to_json[idx] = {
                "image_id": "frame_{:05d}.jpg".format(idx + 1),
                "height": H,
                "width": W,
                "category_id": 1,
                "keypoints_body": kp2ds_body.tolist(),
                "keypoints_left_hand": kp2ds_lhand.tolist(),
                "keypoints_right_hand": kp2ds_rhand.tolist(),
            }
    return img


def draw_nose(
    img,
    kp2ds,
    threshold=0.6,
    data_to_json=None,
    idx=-1,
    kp2ds_lhand=None,
    kp2ds_rhand=None,
    draw_hand=False,
    stick_width_norm=200,
):
    """
    Draw keypoints and connections representing hand pose on a given canvas.

    Args:
        canvas (np.ndarray): A 3D numpy array representing the canvas (image) on which to draw the hand pose.
        keypoints (List[Keypoint]| None): A list of Keypoint objects representing the hand keypoints to be drawn
                                          or None if no keypoints are present.

    Returns:
        np.ndarray: A 3D numpy array representing the modified canvas with the drawn hand pose.

    Note:
        The function expects the x and y coordinates of the keypoints to be normalized between 0 and 1.
    """

    new_kep_list = [
        "Nose",
        "Neck",
        "RShoulder",
        "RElbow",
        "RWrist",  # No.4
        "LShoulder",
        "LElbow",
        "LWrist",  # No.7
        "RHip",
        "RKnee",
        "RAnkle",  # No.10
        "LHip",
        "LKnee",
        "LAnkle",  # No.13
        "REye",
        "LEye",
        "REar",
        "LEar",
        "LToe",
        "RToe",
    ]
    # kp2ds_body = (kp2ds.copy()[[0, 6, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 17, 20]] + \
    #              kp2ds.copy()[[0, 5, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 18, 21]]) / 2
    kp2ds = kp2ds.copy()
    kp2ds[1:, 2] = 0
    # kp2ds[0, 2] = 1
    kp2ds_body = kp2ds
    # kp2ds_body = kp2ds_body[:18]

    # kp2ds_lhand = kp2ds.copy()[91:112]
    # kp2ds_rhand = kp2ds.copy()[112:133]

    limbSeq = [
        # [2, 3],
        # [2, 6],  # shoulders
        # [3, 4],
        # [4, 5],  # left arm
        # [6, 7],
        # [7, 8],  # right arm
        # [2, 9],
        # [9, 10],
        # [10, 11],  # right leg
        # [2, 12],
        # [12, 13],
        # [13, 14],  # left leg
        # [2, 1],
        [1, 15],
        [15, 17],
        [1, 16],
        [16, 18],  # face (nose, eyes, ears)
        # [14, 19],
        # [11, 20],  # foot
    ]

    colors = [
        # [255, 0, 0],
        # [255, 85, 0],
        # [255, 170, 0],
        # [255, 255, 0],
        # [170, 255, 0],
        # [85, 255, 0],
        # [0, 255, 0],
        # [0, 255, 85],
        # [0, 255, 170],
        # [0, 255, 255],
        # [0, 170, 255],
        # [0, 85, 255],
        # [0, 0, 255],
        # [85, 0, 255],
        [170, 0, 255],
        # [255, 0, 255],
        # [255, 0, 170],
        # [255, 0, 85],
        # foot
        # [200, 200, 0],
        # [100, 100, 0],
    ]

    H, W, C = img.shape
    stickwidth = max(int(min(H, W) / stick_width_norm), 1)

    # for _idx, ((k1_index, k2_index), color) in enumerate(zip(limbSeq, colors)):
    #     keypoint1 = kp2ds_body[k1_index - 1]
    #     keypoint2 = kp2ds_body[k2_index - 1]

    #     if keypoint1[-1] < threshold or keypoint2[-1] < threshold:
    #         continue

    #     Y = np.array([keypoint1[0], keypoint2[0]])
    #     X = np.array([keypoint1[1], keypoint2[1]])
    #     mX = np.mean(X)
    #     mY = np.mean(Y)
    #     length = ((X[0] - X[1]) ** 2 + (Y[0] - Y[1]) ** 2) ** 0.5
    #     angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
    #     polygon = cv2.ellipse2Poly((int(mY), int(mX)), (int(length / 2), stickwidth), int(angle), 0, 360, 1)
    #     cv2.fillConvexPoly(img, polygon, [int(float(c) * 0.6) for c in color])

    for _idx, (keypoint, color) in enumerate(zip(kp2ds_body, colors)):
        if keypoint[-1] < threshold:
            continue
        x, y = keypoint[0], keypoint[1]
        # cv2.circle(canvas, (int(x), int(y)), 4, color, thickness=-1)
        cv2.circle(img, (int(x), int(y)), stickwidth, color, thickness=-1)

    if draw_hand:
        img = draw_handpose(img, kp2ds_lhand, hand_score_th=threshold)
        img = draw_handpose(img, kp2ds_rhand, hand_score_th=threshold)

    kp2ds_body[:, 0] /= W
    kp2ds_body[:, 1] /= H

    if data_to_json is not None:
        if idx == -1:
            data_to_json.append(
                {
                    "image_id": "frame_{:05d}.jpg".format(len(data_to_json) + 1),
                    "height": H,
                    "width": W,
                    "category_id": 1,
                    "keypoints_body": kp2ds_body.tolist(),
                    "keypoints_left_hand": kp2ds_lhand.tolist(),
                    "keypoints_right_hand": kp2ds_rhand.tolist(),
                }
            )
        else:
            data_to_json[idx] = {
                "image_id": "frame_{:05d}.jpg".format(idx + 1),
                "height": H,
                "width": W,
                "category_id": 1,
                "keypoints_body": kp2ds_body.tolist(),
                "keypoints_left_hand": kp2ds_lhand.tolist(),
                "keypoints_right_hand": kp2ds_rhand.tolist(),
            }
    return img


def draw_aapose(
    img,
    kp2ds,
    threshold=0.6,
    data_to_json=None,
    idx=-1,
    kp2ds_lhand=None,
    kp2ds_rhand=None,
    draw_hand=False,
    stick_width_norm=200,
    draw_head=True
):
    """
    Draw keypoints and connections representing hand pose on a given canvas.

    Args:
        canvas (np.ndarray): A 3D numpy array representing the canvas (image) on which to draw the hand pose.
        keypoints (List[Keypoint]| None): A list of Keypoint objects representing the hand keypoints to be drawn
                                          or None if no keypoints are present.

    Returns:
        np.ndarray: A 3D numpy array representing the modified canvas with the drawn hand pose.

    Note:
        The function expects the x and y coordinates of the keypoints to be normalized between 0 and 1.
    """

    new_kep_list = [
        "Nose",
        "Neck",
        "RShoulder",
        "RElbow",
        "RWrist",  # No.4
        "LShoulder",
        "LElbow",
        "LWrist",  # No.7
        "RHip",
        "RKnee",
        "RAnkle",  # No.10
        "LHip",
        "LKnee",
        "LAnkle",  # No.13
        "REye",
        "LEye",
        "REar",
        "LEar",
        "LToe",
        "RToe",
    ]
    # kp2ds_body = (kp2ds.copy()[[0, 6, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 17, 20]] + \
    #              kp2ds.copy()[[0, 5, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 18, 21]]) / 2
    kp2ds = kp2ds.copy()
    if not draw_head:
        kp2ds[[0,14,15,16,17], 2] = 0
    kp2ds_body = kp2ds

    # kp2ds_lhand = kp2ds.copy()[91:112]
    # kp2ds_rhand = kp2ds.copy()[112:133]

    limbSeq = [
        [2, 3],
        [2, 6],  # shoulders
        [3, 4],
        [4, 5],  # left arm
        [6, 7],
        [7, 8],  # right arm
        [2, 9],
        [9, 10],
        [10, 11],  # right leg
        [2, 12],
        [12, 13],
        [13, 14],  # left leg
        [2, 1],
        [1, 15],
        [15, 17],
        [1, 16],
        [16, 18],  # face (nose, eyes, ears)
        [14, 19],
        [11, 20],  # foot
    ]

    colors = [
        [255, 0, 0],
        [255, 85, 0],
        [255, 170, 0],
        [255, 255, 0],
        [170, 255, 0],
        [85, 255, 0],
        [0, 255, 0],
        [0, 255, 85],
        [0, 255, 170],
        [0, 255, 255],
        [0, 170, 255],
        [0, 85, 255],
        [0, 0, 255],
        [85, 0, 255],
        [170, 0, 255],
        [255, 0, 255],
        [255, 0, 170],
        [255, 0, 85],
        # foot
        [200, 200, 0],
        [100, 100, 0],
    ]

    H, W, C = img.shape
    stickwidth = max(int(min(H, W) / stick_width_norm), 1)

    for _idx, ((k1_index, k2_index), color) in enumerate(zip(limbSeq, colors)):
        keypoint1 = kp2ds_body[k1_index - 1]
        keypoint2 = kp2ds_body[k2_index - 1]

        if keypoint1[-1] < threshold or keypoint2[-1] < threshold:
            continue

        Y = np.array([keypoint1[0], keypoint2[0]])
        X = np.array([keypoint1[1], keypoint2[1]])
        mX = np.mean(X)
        mY = np.mean(Y)
        length = ((X[0] - X[1]) ** 2 + (Y[0] - Y[1]) ** 2) ** 0.5
        angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
        polygon = cv2.ellipse2Poly((int(mY), int(mX)), (int(length / 2), stickwidth), int(angle), 0, 360, 1)
        cv2.fillConvexPoly(img, polygon, [int(float(c) * 0.6) for c in color])

    for _idx, (keypoint, color) in enumerate(zip(kp2ds_body, colors)):
        if keypoint[-1] < threshold:
            continue
        x, y = keypoint[0], keypoint[1]
        # cv2.circle(canvas, (int(x), int(y)), 4, color, thickness=-1)
        cv2.circle(img, (int(x), int(y)), stickwidth, color, thickness=-1)

    if draw_hand:
        img = draw_handpose(img, kp2ds_lhand, hand_score_th=threshold)
        img = draw_handpose(img, kp2ds_rhand, hand_score_th=threshold)

    kp2ds_body[:, 0] /= W
    kp2ds_body[:, 1] /= H

    if data_to_json is not None:
        if idx == -1:
            data_to_json.append(
                {
                    "image_id": "frame_{:05d}.jpg".format(len(data_to_json) + 1),
                    "height": H,
                    "width": W,
                    "category_id": 1,
                    "keypoints_body": kp2ds_body.tolist(),
                    "keypoints_left_hand": kp2ds_lhand.tolist(),
                    "keypoints_right_hand": kp2ds_rhand.tolist(),
                }
            )
        else:
            data_to_json[idx] = {
                "image_id": "frame_{:05d}.jpg".format(idx + 1),
                "height": H,
                "width": W,
                "category_id": 1,
                "keypoints_body": kp2ds_body.tolist(),
                "keypoints_left_hand": kp2ds_lhand.tolist(),
                "keypoints_right_hand": kp2ds_rhand.tolist(),
            }
    return img


def draw_aapose_new(
    img,
    kp2ds,
    threshold=0.6,
    data_to_json=None,
    idx=-1,
    kp2ds_lhand=None,
    kp2ds_rhand=None,
    draw_hand=False,
    stickwidth_type='v2',
    body_stick_width=-1,
    hand_stick_width=-1,
    draw_head=True
):
    """
    Draw keypoints and connections representing hand pose on a given canvas.

    Args:
        canvas (np.ndarray): A 3D numpy array representing the canvas (image) on which to draw the hand pose.
        keypoints (List[Keypoint]| None): A list of Keypoint objects representing the hand keypoints to be drawn
                                          or None if no keypoints are present.

    Returns:
        np.ndarray: A 3D numpy array representing the modified canvas with the drawn hand pose.

    Note:
        The function expects the x and y coordinates of the keypoints to be normalized between 0 and 1.
    """

    new_kep_list = [
        "Nose",
        "Neck",
        "RShoulder",
        "RElbow",
        "RWrist",  # No.4
        "LShoulder",
        "LElbow",
        "LWrist",  # No.7
        "RHip",
        "RKnee",
        "RAnkle",  # No.10
        "LHip",
        "LKnee",
        "LAnkle",  # No.13
        "REye",
        "LEye",
        "REar",
        "LEar",
        "LToe",
        "RToe",
    ]
    # kp2ds_body = (kp2ds.copy()[[0, 6, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 17, 20]] + \
    #              kp2ds.copy()[[0, 5, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3, 18, 21]]) / 2
    kp2ds = kp2ds.copy()
    if not draw_head:
        kp2ds[[0,14,15,16,17], 2] = 0
    kp2ds_body = kp2ds

    # kp2ds_lhand = kp2ds.copy()[91:112]
    # kp2ds_rhand = kp2ds.copy()[112:133]

    limbSeq = [
        [2, 3],
        [2, 6],  # shoulders
        [3, 4],
        [4, 5],  # left arm
        [6, 7],
        [7, 8],  # right arm
        [2, 9],
        [9, 10],
        [10, 11],  # right leg
        [2, 12],
        [12, 13],
        [13, 14],  # left leg
        [2, 1],
        [1, 15],
        [15, 17],
        [1, 16],
        [16, 18],  # face (nose, eyes, ears)
        [14, 19],
        [11, 20],  # foot
    ]

    colors = [
        [255, 0, 0],
        [255, 85, 0],
        [255, 170, 0],
        [255, 255, 0],
        [170, 255, 0],
        [85, 255, 0],
        [0, 255, 0],
        [0, 255, 85],
        [0, 255, 170],
        [0, 255, 255],
        [0, 170, 255],
        [0, 85, 255],
        [0, 0, 255],
        [85, 0, 255],
        [170, 0, 255],
        [255, 0, 255],
        [255, 0, 170],
        [255, 0, 85],
        # foot
        [200, 200, 0],
        [100, 100, 0],
    ]

    H, W, C = img.shape
    H, W, C = img.shape

    #if stickwidth_type == 'v1':
    #    stickwidth = max(int(min(H, W) / 200), 1)
    #elif stickwidth_type == 'v2':
    if body_stick_width == -1:
        stickwidth = max(int(min(H, W) / 200) - 1, 1)
    else:
        stickwidth = body_stick_width

    for _idx, ((k1_index, k2_index), color) in enumerate(zip(limbSeq, colors)):
        keypoint1 = kp2ds_body[k1_index - 1]
        keypoint2 = kp2ds_body[k2_index - 1]

        if keypoint1[-1] < threshold or keypoint2[-1] < threshold:
            continue

        Y = np.array([keypoint1[0], keypoint2[0]])
        X = np.array([keypoint1[1], keypoint2[1]])
        mX = np.mean(X)
        mY = np.mean(Y)
        length = ((X[0] - X[1]) ** 2 + (Y[0] - Y[1]) ** 2) ** 0.5
        angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
        polygon = cv2.ellipse2Poly((int(mY), int(mX)), (int(length / 2), stickwidth), int(angle), 0, 360, 1)
        cv2.fillConvexPoly(img, polygon, [int(float(c) * 0.6) for c in color])

    for _idx, (keypoint, color) in enumerate(zip(kp2ds_body, colors)):
        if keypoint[-1] < threshold:
            continue
        x, y = keypoint[0], keypoint[1]
        # cv2.circle(canvas, (int(x), int(y)), 4, color, thickness=-1)
        cv2.circle(img, (int(x), int(y)), stickwidth, color, thickness=-1)

    if draw_hand:
        img = draw_handpose_new(img, kp2ds_lhand, stickwidth_type=stickwidth_type, hand_score_th=threshold, hand_stick_width=hand_stick_width)
        img = draw_handpose_new(img, kp2ds_rhand, stickwidth_type=stickwidth_type, hand_score_th=threshold, hand_stick_width=hand_stick_width)

    kp2ds_body[:, 0] /= W
    kp2ds_body[:, 1] /= H

    if data_to_json is not None:
        if idx == -1:
            data_to_json.append(
                {
                    "image_id": "frame_{:05d}.jpg".format(len(data_to_json) + 1),
                    "height": H,
                    "width": W,
                    "category_id": 1,
                    "keypoints_body": kp2ds_body.tolist(),
                    "keypoints_left_hand": kp2ds_lhand.tolist(),
                    "keypoints_right_hand": kp2ds_rhand.tolist(),
                }
            )
        else:
            data_to_json[idx] = {
                "image_id": "frame_{:05d}.jpg".format(idx + 1),
                "height": H,
                "width": W,
                "category_id": 1,
                "keypoints_body": kp2ds_body.tolist(),
                "keypoints_left_hand": kp2ds_lhand.tolist(),
                "keypoints_right_hand": kp2ds_rhand.tolist(),
            }
    return img


def draw_bbox(img, bbox, color=(255, 0, 0)):
    img = load_image(img)
    bbox = [int(bbox_tmp) for bbox_tmp in bbox]
    cv2.rectangle(img, (bbox[0], bbox[1]), (bbox[2], bbox[3]), color, 2)
    return img


def draw_kp2ds(img, kp2ds, threshold=0, color=(255, 0, 0), skeleton=None, reverse=False):
    img = load_image(img, reverse)

    if skeleton is not None:
        if skeleton == "coco17":
            skeleton_list = [
                [6, 8],
                [8, 10],
                [5, 7],
                [7, 9],
                [11, 13],
                [13, 15],
                [12, 14],
                [14, 16],
                [5, 6],
                [6, 12],
                [12, 11],
                [11, 5],
            ]
            color_list = [
                (255, 0, 0),
                (0, 255, 0),
                (0, 0, 255),
                (255, 255, 0),
                (255, 0, 255),
                (0, 255, 255),
            ]
        elif skeleton == "cocowholebody":
            skeleton_list = [
                [6, 8],
                [8, 10],
                [5, 7],
                [7, 9],
                [11, 13],
                [13, 15],
                [12, 14],
                [14, 16],
                [5, 6],
                [6, 12],
                [12, 11],
                [11, 5],
                [15, 17],
                [15, 18],
                [15, 19],
                [16, 20],
                [16, 21],
                [16, 22],
                [91, 92, 93, 94, 95],
                [91, 96, 97, 98, 99],
                [91, 100, 101, 102, 103],
                [91, 104, 105, 106, 107],
                [91, 108, 109, 110, 111],
                [112, 113, 114, 115, 116],
                [112, 117, 118, 119, 120],
                [112, 121, 122, 123, 124],
                [112, 125, 126, 127, 128],
                [112, 129, 130, 131, 132],
            ]
            color_list = [
                (255, 0, 0),
                (0, 255, 0),
                (0, 0, 255),
                (255, 255, 0),
                (255, 0, 255),
                (0, 255, 255),
            ]
        else:
            color_list = [color]
        for _idx, _skeleton in enumerate(skeleton_list):
            for i in range(len(_skeleton) - 1):
                cv2.line(
                    img,
                    (int(kp2ds[_skeleton[i], 0]), int(kp2ds[_skeleton[i], 1])),
                    (int(kp2ds[_skeleton[i + 1], 0]), int(kp2ds[_skeleton[i + 1], 1])),
                    color_list[_idx % len(color_list)],
                    3,
                )

    for _idx, kp2d in enumerate(kp2ds):
        if kp2d[2] > threshold:
            cv2.circle(img, (int(kp2d[0]), int(kp2d[1])), 3, color, -1)
            # cv2.putText(img,
            #         str(_idx),
            #         (int(kp2d[0, i, 0])*1,
            #             int(kp2d[0, i, 1])*1),
            #         cv2.FONT_HERSHEY_SIMPLEX,
            #         0.75,
            #         color,
            #         2
            #         )

    return img


def draw_pcd(pcd_list, save_path=None):
    fig = plt.figure()
    ax = fig.add_subplot(111, projection="3d")

    color_list = ["r", "g", "b", "y", "p"]

    for _idx, _pcd in enumerate(pcd_list):
        ax.scatter(_pcd[:, 0], _pcd[:, 1], _pcd[:, 2], c=color_list[_idx], marker="o")

    ax.set_xlabel("X")
    ax.set_ylabel("Y")
    ax.set_zlabel("Z")

    if save_path is not None:
        plt.savefig(save_path)
    else:
        plt.savefig("tmp.png")


def load_image(img, reverse=False):
    if type(img) == str:
        img = cv2.imread(img)
    if reverse:
        img = img.astype(np.float32)
        img = img[:, :, ::-1]
        img = img.astype(np.uint8)
    return img


def draw_skeleten(meta):
    kps = []
    for i, kp in enumerate(meta["keypoints_body"]):
        if kp is None:
            # if kp is None:
            kps.append([0, 0, 0])
        else:
            kps.append([*kp, 1])
    kps = np.array(kps)

    kps[:, 0] *= meta["width"]
    kps[:, 1] *= meta["height"]
    pose_img = np.zeros([meta["height"], meta["width"], 3], dtype=np.uint8)

    pose_img = draw_aapose(
        pose_img,
        kps,
        draw_hand=True,
        kp2ds_lhand=meta["keypoints_left_hand"],
        kp2ds_rhand=meta["keypoints_right_hand"],
    )
    return pose_img


def draw_skeleten_with_pncc(pncc: np.ndarray, meta: Dict) -> np.ndarray:
    """
    Args:
        pncc: [H,W,3]
        meta: required keys: keypoints_body: [N, 3] keypoints_left_hand, keypoints_right_hand
    Return:
        np.ndarray [H, W, 3]
    """
    # preprocess keypoints
    kps = []
    for i, kp in enumerate(meta["keypoints_body"]):
        if kp is None:
            # if kp is None:
            kps.append([0, 0, 0])
        elif i in [14, 15, 16, 17]:
            kps.append([0, 0, 0])
        else:
            kps.append([*kp])
    kps = np.stack(kps)

    kps[:, 0] *= pncc.shape[1]
    kps[:, 1] *= pncc.shape[0]

    # draw neck
    canvas = np.zeros_like(pncc)
    if kps[0][2] > 0.6 and kps[1][2] > 0.6:
        canvas = draw_ellipse_by_2kp(canvas, kps[0], kps[1], [0, 0, 255])

    # draw pncc
    mask = (pncc > 0).max(axis=2)
    canvas[mask] = pncc[mask]
    pncc = canvas

    # draw other skeleten
    kps[0] = 0

    meta["keypoints_left_hand"][:, 0] *= meta["width"]
    meta["keypoints_left_hand"][:, 1] *= meta["height"]

    meta["keypoints_right_hand"][:, 0] *= meta["width"]
    meta["keypoints_right_hand"][:, 1] *= meta["height"]
    pose_img = draw_aapose(
        pncc,
        kps,
        draw_hand=True,
        kp2ds_lhand=meta["keypoints_left_hand"],
        kp2ds_rhand=meta["keypoints_right_hand"],
    )
    return pose_img


FACE_CUSTOM_STYLE = {
    "eyeball": {"indexs": [68, 69], "color": [255, 255, 255], "connect": False},
    "left_eyebrow": {"indexs": [17, 18, 19, 20, 21], "color": [0, 255, 0]},
    "right_eyebrow": {"indexs": [22, 23, 24, 25, 26], "color": [0, 0, 255]},
    "left_eye": {"indexs": [36, 37, 38, 39, 40, 41], "color": [255, 255, 0], "close": True},
    "right_eye": {"indexs": [42, 43, 44, 45, 46, 47], "color": [255, 0, 255], "close": True},
    "mouth_outside": {"indexs": list(range(48, 60)), "color": [100, 255, 50], "close": True},
    "mouth_inside": {"indexs": [60, 61, 62, 63, 64, 65, 66, 67], "color": [255, 100, 50], "close": True},
}


def draw_face_kp(img, kps, thickness=2, style=FACE_CUSTOM_STYLE):
    """
    Args:
        img: [H, W, 3]
        kps: [70, 2]
    """
    img = img.copy()
    for key, item in style.items():
        pts = np.array(kps[item["indexs"]]).astype(np.int32)
        connect = item.get("connect", True)
        color = item["color"]
        close = item.get("close", False)
        if connect:
            cv2.polylines(img, [pts], close, color, thickness=thickness)
        else:
            for kp in pts:
                kp = np.array(kp).astype(np.int32)
                cv2.circle(img, kp, thickness * 2, color=color, thickness=-1)
    return img


def draw_traj(metas: List[AAPoseMeta], threshold=0.6):

    colors = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], \
                [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], \
                [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85], [100, 255, 50], [255, 100, 50],
                # foot
                [200, 200, 0],
                [100, 100, 0]
                ]
    limbSeq = [
                    [1, 2], [1, 5],     # shoulders
                    [2, 3], [3, 4],     # left arm
                    [5, 6], [6, 7],     # right arm
                    [1, 8], [8, 9], [9, 10],    # right leg
                    [1, 11], [11, 12], [12, 13],  # left leg
                     # face (nose, eyes, ears)
                    [13, 18], [10, 19] # foot
                ]

    face_seq = [[1, 0], [0, 14], [14, 16], [0, 15], [15, 17]]
    kp_body = np.array([meta.kps_body for meta in metas])
    kp_body_p = np.array([meta.kps_body_p for meta in metas])


    face_seq = random.sample(face_seq, 2)

    kp_lh = np.array([meta.kps_lhand for meta in metas])
    kp_rh = np.array([meta.kps_rhand for meta in metas])

    kp_lh_p = np.array([meta.kps_lhand_p for meta in metas])
    kp_rh_p = np.array([meta.kps_rhand_p for meta in metas])

    # kp_lh = np.concatenate([kp_lh, kp_lh_p], axis=-1)
    # kp_rh = np.concatenate([kp_rh, kp_rh_p], axis=-1)

    new_limbSeq = []
    key_point_list = []
    for _idx, ((k1_index, k2_index)) in enumerate(limbSeq):

        vis = (kp_body_p[:, k1_index] > threshold) * (kp_body_p[:, k2_index] > threshold) * 1
        if vis.sum() * 1.0 / vis.shape[0] > 0.4:
            new_limbSeq.append([k1_index, k2_index])

    for _idx, ((k1_index, k2_index)) in enumerate(limbSeq):

        keypoint1 = kp_body[:, k1_index - 1]
        keypoint2 = kp_body[:, k2_index - 1]
        interleave = random.randint(4, 7)
        randind = random.randint(0, interleave - 1)
        # randind = random.rand(range(interleave), sampling_num)

        Y = np.array([keypoint1[:, 0], keypoint2[:, 0]])
        X = np.array([keypoint1[:, 1], keypoint2[:, 1]])

        vis = (keypoint1[:, -1] > threshold) * (keypoint2[:, -1] > threshold) * 1

        # for randidx in randind:
        t = randind / interleave
        x = (1-t)*Y[0, :] + t*Y[1, :]
        y = (1-t)*X[0, :] + t*X[1, :]

        # np.array([1])
        x = x.astype(int)
        y = y.astype(int)

        new_array = np.array([x, y, vis]).T

        key_point_list.append(new_array)

    indx_lh = random.randint(0, kp_lh.shape[1] - 1)
    lh = kp_lh[:, indx_lh, :]
    lh_p = kp_lh_p[:, indx_lh:indx_lh+1]
    lh = np.concatenate([lh, lh_p], axis=-1)

    indx_rh = random.randint(0, kp_rh.shape[1] - 1)
    rh = kp_rh[:, random.randint(0, kp_rh.shape[1] - 1), :]
    rh_p = kp_rh_p[:, indx_rh:indx_rh+1]
    rh = np.concatenate([rh, rh_p], axis=-1)



    lh[-1, :] = (lh[-1, :] > threshold) * 1
    rh[-1, :] = (rh[-1, :] > threshold) * 1

    # print(rh.shape, new_array.shape)
    # exit()
    key_point_list.append(lh.astype(int))
    key_point_list.append(rh.astype(int))


    key_points_list = np.stack(key_point_list)
    num_points = len(key_points_list)
    sample_colors = random.sample(colors, num_points)

    stickwidth = max(int(min(metas[0].width, metas[0].height) / 150), 2)

    image_list_ori = []
    for i in range(key_points_list.shape[-2]):
        _image_vis = np.zeros((metas[0].width, metas[0].height, 3))
        points = key_points_list[:, i, :]
        for idx, point in enumerate(points):
            x, y, vis = point
            if vis == 1:
                cv2.circle(_image_vis, (x, y), stickwidth, sample_colors[idx], thickness=-1)

        image_list_ori.append(_image_vis)

    return image_list_ori
