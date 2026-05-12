"""GJJ 多功能扩图工具节点包。

该包集成了四种扩图工作流：
- SD1.5 局部重绘
- Flux1 Fill Dev
- Flux2 Klein
- Qwen Image Edit
"""

import os
import sys

# 工作流和工具函数在各自的模块中定义
# 节点定义在主文件 gjj_outpaint_studio.py 中

# 导出工作流函数（供主文件在需要时导入）
def get_workflow_functions():
    """获取工作流函数（延迟导入避免循环依赖）"""
    from .sd15_inpaint import execute_sd15_workflow
    from .flux1_fill import execute_flux1_workflow
    from .flux2_klein import execute_flux2_workflow
    from .qwen_image import execute_qwen_workflow
    return {
        "sd15_inpaint": execute_sd15_workflow,
        "flux1_fill": execute_flux1_workflow,
        "flux2_klein": execute_flux2_workflow,
        "qwen_image": execute_qwen_workflow,
    }

# 不在此处定义节点映射，让主文件处理
