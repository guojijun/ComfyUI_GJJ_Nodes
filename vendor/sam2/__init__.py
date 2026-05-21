# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.

# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

try:
    from hydra import initialize_config_module
    from hydra.core.global_hydra import GlobalHydra
except Exception:
    initialize_config_module = None
    GlobalHydra = None

if GlobalHydra is not None and not GlobalHydra.instance().is_initialized():
    initialize_config_module("sam2", version_base="1.2")
