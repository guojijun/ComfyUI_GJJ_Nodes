import { app } from "/scripts/app.js";

// GJJ 换脸分析器前端扩展
// 确保 MIXED_BATCH_IMAGE_TYPE 插槽颜色正确显示

const NODE_CLASS = "GJJ_FaceAnalysis";
const MIXED_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";

app.registerExtension({
	name: "GJJ.FaceAnalysis",
	
	setup() {
		// 注册自定义类型颜色（如果尚未注册）
		if (window.LiteGraph) {
			const canvas = window.LiteGraph;
			
			// 为 MIXED_BATCH_IMAGE_TYPE 设置默认连接颜色
			if (!canvas.default_connection_color_byType[MIXED_BATCH_IMAGE_TYPE]) {
				canvas.default_connection_color_byType[MIXED_BATCH_IMAGE_TYPE] = "#4A90E2"; // 蓝色
			}
			
			// 在 LGraphCanvas 中也设置
			if (window.LGraphCanvas && !window.LGraphCanvas.link_type_colors[MIXED_BATCH_IMAGE_TYPE]) {
				window.LGraphCanvas.link_type_colors[MIXED_BATCH_IMAGE_TYPE] = "#4A90E2";
			}
		}
	},
	
	nodeCreated(node) {
		if (node.comfyClass !== NODE_CLASS) {
			return;
		}
		
		// 确保输入插槽使用正确的类型标签
		if (node.inputs && node.inputs.length >= 2) {
			// 目标图输入
			if (node.inputs[0]) {
				node.inputs[0].label = "目标图";
			}
			// 源图输入
			if (node.inputs[1]) {
				node.inputs[1].label = "源图";
			}
		}
	},
});
