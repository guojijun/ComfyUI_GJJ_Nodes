import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";
import { GJJ_STANDARDIZE_NODE } from "./gjj_common_node_standardizer.js";

GJJ_STANDARDIZE_NODE({
	nodeClass: "GJJ_OpusMTZhEnTranslation",
	displayName: "🌐 Opus-MT中英翻译器 🌍",
	description: "使用 Helsinki-NLP/opus-mt-zh-en 模型将中文翻译为英文。支持自动下载模型到 models/translation 目录。",
	searchAliases: ["translation", "opus mt", "中英翻译", "translation", "chinese to english"],
	helpEntries: [
		"【模型信息】",
		"• 使用 Helsinki-NLP/opus-mt-zh-en 模型",
		"• 专为中文→英文翻译训练的序列到序列模型",
		"• 模型自动下载到: models/translation/opus-mt-zh-en/",
		"",
		"【必需依赖】",
		"• transformers (用于加载和运行模型)",
		"• tokenizers (文本分词处理)",
		"• huggingface_hub (自动下载模型时需要)",
		"• torch (PyTorch 深度学习框架)",
		"",
		"【模型目录】",
		"• ComfyUI 根目录下的 models/translation/opus-mt-zh-en/",
		"• 完整路径示例: [ComfyUI根目录]/models/translation/opus-mt-zh-en/",
		"",
		"【使用说明】",
		"• 首次使用会自动下载模型（约200MB）",
		"• 支持GPU加速，自动检测可用设备",
		"• 可选择使用后卸载模型以释放显存",
		"• 批处理大小影响内存使用和处理速度"
	],
	inputSpec: {
		required: {
			chinese_text: ["STRING", {
				default: "",
				multiline: true,
				label: "中文输入文本",
				tooltip: "输入需要翻译的中文文本。",
			}],
			device: [["auto", "cpu", "gpu"], {
				default: "auto",
				label: "设备选择",
				tooltip: "选择运行模型的设备。auto 会自动选择 GPU（如果可用）或 CPU。",
			}],
			max_length: ["INT", {
				default: 512,
				min: 64,
				max: 1024,
				step: 64,
				label: "最大长度",
				tooltip: "输入和输出的最大 token 长度。",
			}],
			batch_size: ["INT", {
				default: 8,
				min: 1,
				max: 32,
				step: 1,
				label: "批处理大小",
				tooltip: "同时处理的句子数量，影响内存使用和速度。",
			}],
			unload_after_use: ["BOOLEAN", {
				default: false,
				label: "使用后卸载模型",
				tooltip: "翻译完成后是否卸载模型以释放显存。",
			}],
		},
	},
	outputSpec: {
		output: ["STRING"],
		outputNames: ["英文翻译结果"],
		outputTooltips: ["翻译后的英文文本内容。"],
	},
	category: "GJJ/翻译",
});
