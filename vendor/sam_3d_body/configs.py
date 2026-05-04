# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# Inlined model configuration. Replaces configs/model_config.yaml + utils/config.py.
# No yacs, omegaconf, or YAML dependencies.


class CfgNode(dict):
    """Minimal frozen config with attribute access."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self[name] = value

    def get(self, key, default=None):
        return super().get(key, default)

    def defrost(self):
        pass

    def freeze(self):
        pass


def _to_cfg(d):
    if isinstance(d, dict):
        return CfgNode({k: _to_cfg(v) for k, v in d.items()})
    if isinstance(d, list):
        return [_to_cfg(x) for x in d]
    return d


def get_default_config():
    return _to_cfg({
        "MODEL": {
            "IMAGE_SIZE": [512, 512],
            "IMAGE_MEAN": [0.485, 0.456, 0.406],
            "IMAGE_STD": [0.229, 0.224, 0.225],
            "BACKBONE": {
                "TYPE": "dinov3_vith16plus",
                "PRETRAINED_WEIGHTS": "",
                "FROZEN_STAGES": -1,
                "DROP_PATH_RATE": 0.1,
            },
            "DECODER": {
                "TYPE": "sam",
                "DIM": 1024,
                "DEPTH": 6,
                "HEADS": 8,
                "MLP_DIM": 1024,
                "DIM_HEAD": 64,
                "LAYER_SCALE_INIT": 0.0,
                "DROP_RATE": 0.0,
                "ATTN_DROP_RATE": 0.0,
                "DROP_PATH_RATE": 0.0,
                "FFN_TYPE": "origin",
                "ENABLE_TWOWAY": False,
                "REPEAT_PE": True,
                "FROZEN": False,
                "CONDITION_TYPE": "cliff",
                "USE_INTRIN_CENTER": True,
                "DO_INTERM_PREDS": True,
                "DO_INTERM_SUP": True,
                "DO_KEYPOINT_TOKENS": True,
                "DO_HAND_DETECT_TOKENS": True,
                "KEYPOINT_TOKEN_UPDATE": "v2",
                "KEYPOINT_TOKEN_UPDATE_COORD_EMB_USE_MLP": True,
                "DO_KEYPOINT3D_TOKENS": True,
            },
            "PROMPT_ENCODER": {
                "ENABLE": True,
                "MAX_NUM_CLICKS": 2,
                "PROMPT_KEYPOINTS": "mhr70",
                "FROZEN": False,
                "KEYPOINT_SAMPLER": {
                    "TYPE": "v1",
                    "WORST_RATIO": 0.8,
                    "KEYBODY_RATIO": 0.8,
                    "NEGATIVE_RATIO": 0.1,
                    "DUMMY_RATIO": 0.1,
                    "DISTANCE_THRESH": 0.0001,
                },
                "MASK_EMBED_TYPE": "v2",
                "MASK_PROMPT": "v1",
            },
            "PERSON_HEAD": {
                "POSE_TYPE": "mhr",
                "CAMERA_ENABLE": True,
                "CAMERA_TYPE": "perspective",
                "ZERO_POSE_INIT": True,
                "ZERO_POSE_INIT_BODY_FACTOR": 1,
            },
            "MHR_HEAD": {
                "MLP_DEPTH": 2,
                "MLP_CHANNEL_DIV_FACTOR": 1,
                "MHR_MODEL_PATH": "",
            },
            "CAMERA_HEAD": {
                "MLP_DEPTH": 2,
                "MLP_CHANNEL_DIV_FACTOR": 1,
                "DEFAULT_SCALE_FACTOR_HAND": 10,
            },
            "ENABLE_BODY": True,
            "ENABLE_HAND": True,
        },
    })
