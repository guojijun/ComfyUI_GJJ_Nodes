import { app } from "/scripts/app.js";
import "./gjj_common_dependency_model_notice.js";
import { GJJ_STANDARDIZE_NODE } from "./gjj_common_node_standardizer.js";

const NODE_CLASS = "GJJ_OldPhotoRestorer";
const COMPAT_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";

GJJ_STANDARDIZE_NODE({
	nodeClass: NODE_CLASS,
	displayName: "GJJ · 🕰️ 一键批量修复老照片",
	category: "GJJ",
	description: "将 FireRed Image Edit 老照片修复工作流封装为单节点，并通过公共状态栏显示进度。",
	enableStatus: true,
	inputSpec: {
		required: {
			image: [COMPAT_BATCH_IMAGE_TYPE, {
				display_name: "🖼️ 输入图像",
				tooltip: "需要修复或增强的老照片图像。支持普通 IMAGE 或 GJJ_BATCH_IMAGE 批量图像。",
			}],
			prompt: ["STRING", {
				display_name: "📝 修复提示词",
				tooltip: "用于指导老照片修复增强的提示词。",
			}],
			unet_name: ["COMBO", {
				display_name: "🟣 UNET 主模型",
				tooltip: "主修复模型。此节点只支持 FireRed Image Edit；面板只显示 diffusion_models 下匹配 FireRed 的模型，搜索不要求版本号。",
			}],
			seed: ["INT", {
				display_name: "🎲 种子",
				tooltip: "控制采样随机性的种子值。",
			}],
			enable_upscale: ["BOOLEAN", {
				display_name: "🔍 启用放大",
				tooltip: "开启后会在生成完成后接着用超分模型做一次图像增强。",
			}],
			upscale_model_name: ["COMBO", {
				display_name: "🔎 放大模型",
				tooltip: "用于结果图像增强的放大模型。保留 upscale_models 下全部模型选项，默认按 1xSkinContrast 关键词模糊匹配。",
			}],
		},
	},
	outputSpec: {
		outputNames: ["🕰️ 修复增强图像"],
		outputTooltips: ["老照片修复增强后的图像结果，兼容 GJJ_BATCH_IMAGE 和 IMAGE 连接。"],
	},
});

app.registerExtension({
	name: "GJJ.OldPhotoRestorer.CommonPanel",
	nodeCreated(node) {
		if (String(node?.comfyClass || node?.type || "") !== NODE_CLASS) {
			return;
		}
		globalThis.GJJ_CommonNodeStandardizer?.registerStatusClass?.(NODE_CLASS);
		globalThis.GJJ_CommonNodeStandardizer?.patchNode?.(node);
		globalThis.GJJ_CommonDependencyModelNotice?.initializeNodePanel?.(node);
		globalThis.GJJApplyTypeColorsToNode?.(node);
	},
});
