import sys, os, site, traceback, importlib, re
from typing import List, Optional
DEFAULT_PYPI = "https://pypi.tuna.tsinghua.edu.cn/simple"
DEFAULT_MODEL_URL = "https://pan.quark.cn/s/4b5a36d50e9c"
def _console_dependency_warnings_enabled():
	value = str(os.environ.get("GJJ_SHOW_STARTUP_DEPENDENCY_WARNINGS", "") or "").strip().lower()
	return value in {"1", "true", "yes", "on", "debug"}
def _import_ok(pkg):
	try: return importlib.util.find_spec(str(pkg or "").strip()) is not None
	except:return False
def _norm(v):
	if not v:return []
	if isinstance(v, str):v = re.split(r"[\s,/]+", v)
	r, seen = [], set()
	for x in v:
		for i in re.split(r"[\s,/]+", str(x)):
			if i and i not in seen:seen.add(i);r.append(i)
	return r

def get_site_packages(py=None):
	py = py or sys.executable
	py_dir = os.path.dirname(py)

	for p in (site.getsitepackages() +[site.getusersitepackages()]):
		try:
			if "site-packages" in p and p.lower().startswith(py_dir.lower()):return p
		except:
			pass
	return os.path.join(py_dir, "Lib", "site-packages")

def get_pip_install_command_text(pkg="",*,packages=None,py=None):
	pkg = " ".join(f'"{item}"' for item in _norm(packages or pkg))
	return (f'& "{py or sys.executable}" -m pip install {pkg} -i {DEFAULT_PYPI} --ignore-installed --target "{get_site_packages(py)}"')

def analyze_import_error(error_message, dependency_name=""):
	"""
	智能分析导入错误类型，返回更准确的错误描述
	
	参数:
		error_message: 原始错误信息
		dependency_name: 依赖名称
	
	返回:
		dict: {
			"error_type": "missing" | "version_incompatible" | "api_removed" | "runtime_missing" | "unknown",
			"description": "人类可读的错误描述",
			"suggestion": "解决建议"
		}
	"""
	error_str = str(error_message).lower()
	
	# 0. 检测运行时依赖缺失（PyTorch/Triton 等）
	runtime_missing_patterns = [
		r"triton.*not installed|triton.*too old|cannot find.*triton",  # Triton 缺失或过旧
		r"torch._inductor.*missing",                                    # PyTorch Inductor 依赖缺失
		r"cuda.*not available|no cuda device",                          # CUDA 不可用
		r"cudnn.*not found|cudnn.*error",                               # cuDNN 问题
	]
	
	# 1. 检测版本不兼容/API移除错误
	api_removed_patterns = [
		r"cannot import name .+ from",           # cannot import name 'X' from 'Y'
		r"has no attribute",                      # module has no attribute 'X'
		r"no module named .+; .+ is not a package",  # 模块存在但不是包
	]
	
	version_incompatible_patterns = [
		r"requires .+ but you have",              # requires X but you have Y
		r"incompatible.*version",                 # incompatible version
		r"version mismatch",                      # version mismatch
	]
	
	missing_patterns = [
		r"no module named",                       # No module named 'X'
		r"module not found",                      # Module not found
	]
	
	# 检查运行时依赖缺失（最高优先级）
	for pattern in runtime_missing_patterns:
		if re.search(pattern, error_str):
			# 特殊处理 Triton 错误
			if "triton" in error_str:
				return {
					"error_type": "runtime_missing",
					"description": f"缺少 PyTorch 编译加速依赖 triton（用于 torch.compile/torch._inductor）",
					"suggestion": f"请安装 triton：pip install triton -i https://pypi.tuna.tsinghua.edu.cn/simple"
				}
			elif "cuda" in error_str or "cudnn" in error_str:
				return {
					"error_type": "runtime_missing",
					"description": f"CUDA/cuDNN 运行时环境配置问题",
					"suggestion": f"请检查 NVIDIA 驱动和 CUDA Toolkit 是否正确安装"
				}
			else:
				return {
					"error_type": "runtime_missing",
					"description": f"缺少 PyTorch 运行时依赖",
					"suggestion": f"请根据错误信息安装缺失的运行时组件"
				}
	
	# 检查 API 移除/版本不兼容
	for pattern in api_removed_patterns:
		if re.search(pattern, error_str):
			return {
				"error_type": "api_removed",
				"description": f"{dependency_name} 已安装但版本不兼容（API 已变更或移除）",
				"suggestion": f"请升级 {dependency_name} 到最新版本：pip install --upgrade {dependency_name}"
			}
	
	# 检查明确的版本冲突
	for pattern in version_incompatible_patterns:
		if re.search(pattern, error_str):
			return {
				"error_type": "version_incompatible",
				"description": f"{dependency_name} 版本不兼容",
				"suggestion": f"请更新 {dependency_name} 到兼容版本"
			}
	
	# 检查缺失模块
	for pattern in missing_patterns:
		if re.search(pattern, error_str):
			return {
				"error_type": "missing",
				"description": f"缺少依赖 {dependency_name}",
				"suggestion": f"请安装 {dependency_name}：pip install {dependency_name}"
			}
	
	# 默认：未知错误类型，但仍可能是版本问题
	return {
		"error_type": "unknown",
		"description": f"{dependency_name} 导入失败",
		"suggestion": f"请检查 {dependency_name} 是否正确安装且版本兼容"
	}

def build_dependency_model_report(node_name="",missing_dependencies=None,missing_models=None,install_packages=None,description="",original_error="",model_download_url=None,optional_dependencies=None,optional_install_packages=None):
	deps = [x if isinstance(x,dict) else {"module_name":x,"package_name":x,"display_name":x,"description":""} for x in (missing_dependencies or [])]
	optional_deps = [x if isinstance(x,dict) else {"module_name":x,"package_name":x,"display_name":x,"description":""} for x in (optional_dependencies or [])]
	models = missing_models or []
	cmd_packages = install_packages or [x.get("package_name") or x.get("module_name") for x in deps if (x.get("package_name") or x.get("module_name"))]
	optional_cmd_packages = optional_install_packages or [x.get("package_name") or x.get("module_name") for x in optional_deps if (x.get("package_name") or x.get("module_name"))]
	cmd = get_pip_install_command_text(packages=cmd_packages) if deps else ""
	optional_cmd = get_pip_install_command_text(packages=optional_cmd_packages) if optional_deps else ""
	default_download_url = str(model_download_url or DEFAULT_MODEL_URL or "").strip()
	if deps or models:
		notice_level = "error"
		warning = "⚠️缺失"
		if deps and models:
			warning += "运行依赖、模型"
		elif deps:
			warning += "运行依赖"
		elif models:
			warning += "模型"
		warning += "，点击❓按钮了解详情。"
	elif optional_deps:
		notice_level = "optional"
		warning = "⚠️可选依赖缺失，基础功能可用；点击❓按钮了解详情。"
	else:
		notice_level = "ok"
		warning = ""
	msg = [warning]
	if description: msg += ["", description]
	if deps:
		msg += ["", "📦 必需依赖："]
		for d in deps:
			label = d.get("display_name") or d.get("package_name") or d.get("module_name") or "unknown"
			desc = d.get("description") or ""
			msg.append(f"• {label}" + (f"：{desc}" if desc else ""))
		if cmd:
			msg += ["", "🔧 快速安装命令：", "", cmd]
	if optional_deps:
		msg += ["", "🟡 可选依赖："]
		for d in optional_deps:
			label = d.get("display_name") or d.get("package_name") or d.get("module_name") or "unknown"
			desc = d.get("description") or ""
			msg.append(f"• {label}" + (f"：{desc}" if desc else ""))
		if optional_cmd:
			msg += ["", "🔧 可选安装命令：", "", optional_cmd]
	if models:
		msg += ["", "🌏 模型："]
		for m in models:
			path = "/".join(filter(None, [m.get("subdir"), m.get("filename")]))
			label = m.get("label") or m.get("filename") or "unknown"
			desc = m.get("description") or ""
			line = f"• {label}：{path}" if path else f"• {label}"
			if desc: line += f" ({desc})"
			msg.append(line)
	if original_error: msg += ["", f"原始错误:{original_error}"]
	if deps or models or optional_deps:
		msg += ["", "🧡 提示：安装后重启 ComfyUI 🧡"]
	panel_message = "\n".join(msg)
	copy_text = cmd or optional_cmd or default_download_url
	copy_label = "📋 复制安装命令" if cmd else ("📋 复制可选安装命令" if optional_cmd else "📋 复制下载地址")
	dependencies_available = not deps
	models_available = not models
	return {
		"available": dependencies_available and models_available,
		"dependencies_available": dependencies_available,
		"models_available": models_available,
		"missing_dependencies": deps,
		"optional_dependencies": optional_deps,
		"optional_dependencies_available": not optional_deps,
		"missing_models": models,
		"notice_level": notice_level,
		"warning_message": warning,
		"description_message": warning,
		"panel_message": panel_message,
		"help_message": panel_message,
		"console_message": panel_message,
		"install_cmd": cmd,
		"optional_install_cmd": optional_cmd,
		"copy_text": copy_text,
		"copy_label": copy_label,
		"model_download_url": default_download_url if models else "",
		"original_error": original_error or "",
	}
def print_dependency_model_report(report,title="GJJ 节点运行环境缺失！"):
	if not _console_dependency_warnings_enabled():
		return
	c={"r":"\033[91m","y":"\033[93m","g":"\033[92m","c":"\033[96m","b":"\033[1m","x":"\033[0m"}
	print(f"\n{c['r']}{'='*80}")
	print(f"{c['b']} {title}")
	print("="*80,c["x"])
	if report.get("install_cmd"):
		print(
			f"\n{c['y']}安装命令:"
			f"{c['g']}\n"
			f"{report['install_cmd']}"
			f"{c['x']}")
	print(report["panel_message"])

def send_dependency_model_notice(report, unique_id=None):
	if unique_id is None or report is None:
		return
	try:
		from server import PromptServer
		PromptServer.instance.send_sync("gjj_dependency_model_notice", {
			"node": str(unique_id),
			"warning_message": report.get("warning_message", "⚠️缺失运行依赖，点击❓按钮了解详情。"),
			"panel_message": report.get("panel_message", ""),
			"install_command": report.get("install_cmd", ""),
			"optional_install_command": report.get("optional_install_cmd", ""),
			"copy_text": report.get("copy_text", ""),
			"copy_label": report.get("copy_label", "📋 复制安装命令"),
			"model_download_url": report.get("model_download_url", ""),
			"notice_level": report.get("notice_level", "error"),
			"optional_dependencies": report.get("optional_dependencies", []),
		})
	except Exception:
		pass

def make_missing_model_spec(label="", subdir="", filename="", description=""):
	return {
		"label": str(label or filename or "模型"),
		"subdir": str(subdir or "").strip(),
		"filename": str(filename or "").strip(),
		"description": str(description or "").strip(),
	}

def make_model_tree_item(
	label="",
	folder="",
	filename="",
	description="",
	*,
	path="",
	kind="diffusion",
	icon="🟣",
	type="",
	input="",
	required=True,
):
	clean_folder = str(folder or "").strip().strip("/\\")
	clean_filename = str(filename or "").strip()
	clean_path = str(path or "").strip()
	if not clean_path and clean_folder and clean_filename:
		clean_path = f"models/{clean_folder}/{clean_filename}"
	return {
		"label": str(label or clean_filename or "模型").strip(),
		"path": clean_path,
		"folder": clean_folder,
		"filename": clean_filename,
		"input": str(input or "").strip(),
		"type": str(type or "").strip(),
		"kind": str(kind or "").strip(),
		"icon": str(icon or "").strip(),
		"required": bool(required),
		"tooltip": str(description or "").strip(),
		"description": str(description or "").strip(),
	}

def build_node_help_payload(
	*,
	description="",
	dependencies=None,
	model_tree=None,
	models=None,
	usage=None,
	runtime=None,
	model_download_url=None,
	install_cmd="",
	copy_text="",
	copy_label="",
	notice="",
	extra=None,
):
	"""Build a reusable Chinese GJJ_HELP payload for node help panels."""
	dependency_items = []
	for item in dependencies or []:
		if isinstance(item, dict):
			dependency_items.append({
				"name": str(item.get("name") or item.get("display_name") or item.get("module_name") or "").strip(),
				"type": str(item.get("type") or item.get("kind") or "运行依赖").strip(),
				"required": bool(item.get("required", True)),
				"description": str(item.get("description") or "").strip(),
			})
		else:
			dependency_items.append({"name": str(item or "").strip(), "type": "运行依赖", "required": True, "description": ""})
	dependency_items = [item for item in dependency_items if item.get("name")]

	model_items = [item if isinstance(item, dict) else make_missing_model_spec(filename=str(item or "")) for item in (models or [])]
	tree_items = []
	for item in model_tree or []:
		if isinstance(item, dict):
			tree_items.append({
				"label": str(item.get("label") or item.get("name") or "").strip(),
				"path": str(item.get("path") or item.get("subdir") or item.get("folder") or item.get("directory") or "").strip(),
				"folder": str(item.get("folder") or item.get("directory") or "").strip(),
				"subdir": str(item.get("subdir") or "").strip(),
				"filename": str(item.get("filename") or item.get("file") or "").strip(),
				"value": str(item.get("value") or item.get("filename") or item.get("file") or "").strip(),
				"kind": str(item.get("kind") or item.get("type") or item.get("model_kind") or "").strip(),
				"type": str(item.get("type") or item.get("output_type") or "").strip(),
				"icon": str(item.get("icon") or "").strip(),
				"required": bool(item.get("required", True)),
				"description": str(item.get("description") or item.get("tooltip") or item.get("note") or "").strip(),
			})
		else:
			tree_items.append({"label": str(item or "").strip(), "path": "", "required": True, "description": ""})
	tree_items = [item for item in tree_items if item.get("label") or item.get("path")]

	help_lines = []
	if notice:
		help_lines.append(str(notice).strip())
	if dependency_items:
		help_lines.append("需要的运行环境：" + "；".join(
			f"{item['name']}{'（可选）' if not item.get('required', True) else ''}" for item in dependency_items
		))
	if tree_items:
		help_lines.append("模型树：" + "；".join(
			"/".join(x for x in (item.get("path"), item.get("label")) if x) for item in tree_items
		))

	payload = {
		"description": str(description or "").strip(),
		"notice": str(notice or "").strip(),
		"dependencies": dependency_items,
		"model_tree": tree_items,
		"models": model_items,
		"usage": [str(item).strip() for item in (usage or []) if str(item).strip()],
		"runtime": [str(item).strip() for item in (runtime or []) if str(item).strip()],
		"model_download_url": str(model_download_url or DEFAULT_MODEL_URL or "").strip(),
		"install_cmd": str(install_cmd or "").strip(),
		"copy_text": str(copy_text or install_cmd or model_download_url or "").strip(),
		"copy_label": str(copy_label or ("📋 复制安装命令" if install_cmd else "📋 复制下载地址")).strip(),
		"help_message": "\n".join(line for line in help_lines if line),
	}
	if isinstance(extra, dict):
		payload.update(extra)
	return payload

def raise_dependency_model_error(
	node_name="",
	*,
	missing_dependencies=None,
	missing_models=None,
	install_packages=None,
	description="",
	original_error="",
	unique_id=None,
	title="GJJ 节点运行环境缺失！",
	copy_text=None,
	copy_label=None,
	model_download_url=None,
):
	report = build_dependency_model_report(
		node_name=node_name,
		missing_dependencies=missing_dependencies or [],
		missing_models=missing_models or [],
		install_packages=install_packages,
		description=description,
		original_error=original_error,
	)
	if copy_text is not None:
		report["copy_text"] = str(copy_text or "")
	if copy_label is not None:
		report["copy_label"] = str(copy_label or "")
	if model_download_url is not None:
		report["model_download_url"] = str(model_download_url or "")
	if report.get("install_cmd") and not report.get("copy_text"):
		report["copy_text"] = report["install_cmd"]
	if report.get("missing_models") and not report.get("copy_text"):
		report["copy_text"] = report.get("model_download_url") or DEFAULT_MODEL_URL
	if report.get("copy_text") and not report.get("copy_label"):
		report["copy_label"] = "📋 复制安装命令" if report.get("install_cmd") else "🌏 复制下载网址"
	print_dependency_model_report(report, title=title)
	send_dependency_model_notice(report, unique_id=unique_id)
	err = RuntimeError(report.get("warning_message") or "运行环境缺失")
	setattr(err, "gjj_report", report)
	raise err

def get_report_from_exception(exc):
	return getattr(exc, "gjj_report", None)

def is_comfyui_model_compatibility_error(error, model_name="", clip_type=""):
	text = " ".join(str(item or "") for item in (error, model_name, clip_type)).lower()
	model_tokens = (
		"boogu",
		"boogu_image",
		"boogu-image",
		"krea2",
		"krea-2",
		"krea2_turbo",
		"krea2-turbo",
		"omnigen2",
		"omni-gen2",
	)
	new_model = any(token in text for token in model_tokens)
	structure_mismatch = (
		("size mismatch" in text and "image_index_embedding" in text)
		or ("omnigen2transformer2dmodel" in text and "size mismatch" in text)
		or ("shape '[13568, 3360]'" in text)
		or ("3360" in text and "invalid for input of size" in text)
	)
	version_gap = (
		("has no attribute" in text and ("cliptype" in text or "supported_models" in text or "unetloader" in text))
		or ("no module named" in text and ("comfy.ldm.boogu" in text or "comfy.ldm.krea" in text))
		or "当前 comfyui 环境缺少可用的 unetloader" in text
	)
	return bool(new_model and (structure_mismatch or version_gap))

def build_comfyui_model_compatibility_report(
	node_name="",
	model_name="",
	clip_type="",
	original_error="",
	description="",
):
	family_text = str(clip_type or "").strip()
	model_text = str(model_name or "").strip() or "[未选择]"
	suggestion = (
		description
		or "当前 ComfyUI 的模型结构代码偏旧，不能加载这个新版 UNET 权重。"
		"选择 boogu、krea2 等新版模型时，请更新 ComfyUI 到支持该模型的版本并重启；"
		"如果暂时不更新，请换用当前 ComfyUI 可加载的旧版兼容模型。"
	)
	panel_lines = [
		"⚠️模型与当前 ComfyUI 版本不兼容，点击❓按钮了解详情。",
		"",
		suggestion,
		"",
		f"当前 UNET：{model_text}",
	]
	if family_text:
		panel_lines.append(f"模型类型：{family_text}")
	if original_error:
		panel_lines += ["", f"原始错误:{original_error}"]
	copy_text = "请更新 ComfyUI 到支持 boogu/krea2/OmniGen2 新结构模型的版本，然后重启 ComfyUI；或临时改用旧版兼容模型。"
	return {
		"available": False,
		"dependencies_available": False,
		"models_available": True,
		"missing_dependencies": [],
		"optional_dependencies": [],
		"optional_dependencies_available": True,
		"missing_models": [],
		"notice_level": "error",
		"warning_message": "⚠️模型与当前 ComfyUI 版本不兼容，点击❓按钮了解详情。",
		"description_message": "⚠️模型与当前 ComfyUI 版本不兼容，点击❓按钮了解详情。",
		"panel_message": "\n".join(panel_lines),
		"help_message": "\n".join(panel_lines),
		"console_message": "\n".join(panel_lines),
		"install_cmd": "",
		"optional_install_cmd": "",
		"copy_text": copy_text,
		"copy_label": "📋 复制处理建议",
		"model_download_url": "",
		"original_error": str(original_error or ""),
	}

def raise_comfyui_model_compatibility_error(
	node_name="",
	*,
	model_name="",
	clip_type="",
	original_error="",
	unique_id=None,
	description="",
	title="GJJ 节点模型版本不兼容！",
):
	report = build_comfyui_model_compatibility_report(
		node_name=node_name,
		model_name=model_name,
		clip_type=clip_type,
		original_error=str(original_error or ""),
		description=description,
	)
	print_dependency_model_report(report, title=title)
	send_dependency_model_notice(report, unique_id=unique_id)
	err = RuntimeError(report.get("panel_message") or report.get("warning_message") or "模型与当前 ComfyUI 版本不兼容")
	setattr(err, "gjj_report", report)
	if isinstance(original_error, BaseException):
		raise err from original_error
	raise err
# ========= 外部API =========
def check_dependencies(required_packages,node_name,optional_packages=None):
	req=_norm(required_packages)
	opt=_norm(optional_packages)
	miss=[x for x in req if not _import_ok(x)]
	miss_opt=[x for x in opt if not _import_ok(x)]
	if miss:
		r=build_dependency_model_report(node_name=node_name,missing_dependencies=miss,install_packages=miss+miss_opt)
		return False,r["panel_message"]
	if miss_opt:
		return True,f"⚠️ 可选依赖缺失:{','.join(miss_opt)}"
	return True,f"✅ {node_name} 依赖检查通过"

def load_dependency_at_runtime(module_name,node_name="",package_name="",description="",extra_packages=None,unique_id=None):
	key=f"_gjj_{module_name}"
	if hasattr(sys,key):return getattr(sys,key)
	try:
		m=importlib.import_module(module_name)
		setattr(sys,key,m)
		return m
	except Exception as e:
		# 智能分析错误类型
		error_analysis = analyze_import_error(str(e), package_name or module_name)
		
		# 根据错误类型生成更准确的描述
		if error_analysis["error_type"] in ["api_removed", "version_incompatible"]:
			enhanced_description = f"{error_analysis['description']}\n{error_analysis['suggestion']}"
		elif error_analysis["error_type"] == "runtime_missing":
			enhanced_description = f"{error_analysis['description']}\n{error_analysis['suggestion']}"
		else:
			enhanced_description = description or error_analysis["description"]
		
		report=build_dependency_model_report(
			node_name=node_name,
			missing_dependencies=[package_name or module_name],
			install_packages=[package_name or module_name]+(extra_packages or []),
			description=enhanced_description,
			original_error=str(e)
		)
		
		# 根据错误类型调整标题
		if error_analysis["error_type"] in ["api_removed", "version_incompatible"]:
			title = "GJJ 节点依赖版本不兼容！"
		elif error_analysis["error_type"] == "runtime_missing":
			title = "GJJ 节点运行时组件缺失！"
		else:
			title = "GJJ 节点运行时依赖缺失！"
		
		print_dependency_model_report(report, title)

		send_dependency_model_notice(report, unique_id=unique_id)
		err = RuntimeError(report.get("warning_message") or f"{package_name or module_name} 导入失败")
		setattr(err, "gjj_report", report)
		raise err from e

def print_runtime_dependency_error(node_name="",dependency_name="",install_command="",description="",extra_info="",unique_id=None):
	# 智能分析错误类型
	error_analysis = analyze_import_error(extra_info, dependency_name)
	
	# 根据错误类型生成更准确的描述
	if error_analysis["error_type"] == "api_removed":
		enhanced_description = f"{error_analysis['description']}\n{error_analysis['suggestion']}"
		if description:
			enhanced_description += f"\n\n原始错误: {description}"
	elif error_analysis["error_type"] == "version_incompatible":
		enhanced_description = f"{error_analysis['description']}\n{error_analysis['suggestion']}"
		if description:
			enhanced_description += f"\n\n原始错误: {description}"
	elif error_analysis["error_type"] == "runtime_missing":
		enhanced_description = f"{error_analysis['description']}\n{error_analysis['suggestion']}"
		if description:
			enhanced_description += f"\n\n原始错误: {description}"
	else:
		enhanced_description = description or error_analysis["description"]
	
	r=build_dependency_model_report(node_name=node_name,missing_dependencies=[dependency_name],description=enhanced_description,original_error=extra_info)
	if install_command:r["install_cmd"]=install_command
	
	# 根据错误类型调整标题
	if error_analysis["error_type"] in ["api_removed", "version_incompatible"]:
		title = "GJJ 节点依赖版本不兼容！"
	elif error_analysis["error_type"] == "runtime_missing":
		title = "GJJ 节点运行时组件缺失！"
	else:
		title = "GJJ 节点运行时依赖缺失！"
	
	print_dependency_model_report(r, title)
	
	send_dependency_model_notice(r, unique_id=unique_id)
