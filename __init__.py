print("\033[1;92m" + r"""
💛 ██████╗ ██╗   ██╗███████╗       ██╗ ██╗       ██╗██╗   ██╗███╗   ██╗💛
💛██╔════╝ ██║   ██║██╔══██║       ██║ ██║       ██║██║   ██║████╗  ██║💛
💛██║  ███╗██║   ██║██║  ██║       ██║ ██║       ██║██║   ██║██╔██╗ ██║💛
💛██║   ██║██║   ██║██║  ██║       ██║ ██║       ██║██║   ██║██║╚██╗██║💛
💛╚██████╔╝╚██████╔╝███████║ ╚██████╔╝╚██║ ╚██████╔╝╚██████╔╝██║ ╚████║💛
💛 ╚═════╝  ╚═════╝ ╚══════╝  ╚═════╝  ╚═╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝💛
""".strip() + "\033[0m")
from .nodes import *
WEB_DIRECTORY = "./js"
def _serialize_help_value(value):
	if value is None or isinstance(value, (str, int, float, bool)):
		return value
	if isinstance(value, (list, tuple, set)):
		return [_serialize_help_value(item) for item in value]
	if isinstance(value, dict):
		return {str(key): _serialize_help_value(item) for key, item in value.items()}
	return str(value)
def _build_node_help_payload():
	payload = {}
	for node_name, node_cls in NODE_CLASS_MAPPINGS.items():
		help_data = getattr(node_cls, "GJJ_HELP", None)
		required_models = getattr(node_cls, "REQUIRED_MODELS", None)
		if help_data is None and required_models:
			help_data = {"models": required_models}
		payload[str(node_name)] = {
			"description": str(getattr(node_cls, "DESCRIPTION", "") or ""),
			"help": _serialize_help_value(help_data or {}),
		}
	return payload
def _register_gjj_help_api():
	try:
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 节点帮助接口注册失败：{exc}")
		return
	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_node_help_api_registered", False):
		return
	@server.routes.get("/gjj/node_help")
	async def gjj_node_help(_request):
		return web.json_response(_build_node_help_payload())
	server._gjj_node_help_api_registered = True
_register_gjj_help_api()

def _register_gjj_summon_model_api():
	try:
		import os
		import re
		import folder_paths
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 召唤模型接口注册失败：{exc}")
		return

	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_summon_model_api_registered", False):
		return

	KNOWN_MODEL_EXTENSIONS = {
		".safetensors", ".ckpt", ".pt", ".pt2", ".pth", ".bin", ".gguf",
		".sft", ".pkl", ".onnx", ".engine",
	}
	QUANT_PATTERN = re.compile(
		r"(?i)(^|[\s._\-/\\])("
		r"fp8(?:[\s._-]?e[45]m[23]fn?)?|fp16|fp32|bf16|float16|float32|"
		r"int8|int4|nf4|mxfp4|bnb4bit|bitsandbytes|"
		r"q[2-8](?:[\s._-]?[a-z0-9]+){0,3}|"
		r"e4m3fn|e5m2|gguf"
		r")(?=$|[\s._\-/\\])"
	)
	QUANT_MODIFIER_PATTERN = re.compile(
		r"(?i)(^|[\s._\-/\\])(?:input[\s._-]?)?scaled(?=$|[\s._\-/\\])"
	)
	RANK_TOKEN_PATTERN = re.compile(r"(?i)^(?:rank|dim|r)\d+$")
	NOTE_BLOCK_PATTERN = re.compile(
		r"(?:[\s._-]*(?:\([^)]*\)|\[[^\]]*\]|（[^）]*）|【[^】]*】))+$"
	)
	NOTE_TOKEN_PATTERN = re.compile(
		r"(?i)^(?:v(?:er(?:sion)?)?\d+(?:\.\d+)*|final\d*|最终版|修订版|备注.*)$"
	)
	CHINESE_PATTERN = re.compile(r"[\u4e00-\u9fff]")
	LOOSE_NOTE_SUFFIXES = {
		"kj", "kijai", "fix", "fixed", "patch", "patched",
		"convert", "converted", "comfy", "comfyui",
	}
	CATEGORY_ALIASES = {
		"checkpoint": ("checkpoints",),
		"ckpt": ("checkpoints",),
		"unet": ("diffusion_models",),
		"diffusion_model": ("diffusion_models",),
		"diffusion_models": ("diffusion_models",),
		"unet_gguf": ("unet_gguf",),
		"text_encoder": ("text_encoders", "clip"),
		"text_encoders": ("text_encoders", "clip"),
		"clip": ("text_encoders", "clip"),
		"clip_vision": ("clip_vision",),
		"vae": ("vae",),
		"vae_approx": ("vae_approx",),
		"lora": ("loras",),
		"loras": ("loras",),
		"controlnet": ("controlnet", "controlnets"),
		"controlnets": ("controlnet", "controlnets"),
		"upscale": ("upscale_models", "latent_upscale_models"),
		"upscale_model": ("upscale_models", "latent_upscale_models"),
		"upscale_models": ("upscale_models",),
		"latent_upscale_models": ("latent_upscale_models", "upscale_models"),
		"audio_encoder": ("audio_encoders",),
		"audio_encoders": ("audio_encoders",),
		"detection": ("detection", "onnx", "ultralytics_bbox"),
		"onnx": ("onnx", "detection"),
		"yolo": ("ultralytics_bbox", "detection", "onnx"),
		"ultralytics": ("ultralytics_bbox",),
		"ultralytics_bbox": ("ultralytics_bbox", "detection", "onnx"),
		"bbox": ("ultralytics_bbox", "detection", "onnx"),
	}
	SKIP_FOLDERS = {"custom_nodes", "input", "output", "temp", "configs"}

	def strip_extension(text):
		value = str(text or "").strip().replace("\\", "/")
		lower = value.lower()
		for ext in sorted(KNOWN_MODEL_EXTENSIONS, key=len, reverse=True):
			if lower.endswith(ext):
				return value[:-len(ext)]
		root, ext = os.path.splitext(value)
		return root if ext and len(ext) <= 12 else value

	def clean_model_key(text, basename_only=True):
		value = str(text or "").strip().replace("\\", "/")
		if basename_only:
			value = value.rsplit("/", 1)[-1]
		value = strip_extension(value)
		value = QUANT_PATTERN.sub(" ", value)
		value = QUANT_MODIFIER_PATTERN.sub(" ", value)
		value = re.sub(r"(?i)\b(?:fp|bf|int)\s*(?:8|16|32)\b", " ", value)
		value = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", " ", value.lower())
		return re.sub(r"\s+", " ", value).strip()

	def compact_key(text, basename_only=True):
		return re.sub(r"\s+", "", clean_model_key(text, basename_only=basename_only))

	def token_signature(text):
		tokens = [token for token in clean_model_key(text, basename_only=True).split() if token]
		return tuple(sorted(tokens))

	def rank_variant_signature(text):
		tokens = [token for token in clean_model_key(text, basename_only=True).split() if token]
		result = []
		changed = False
		has_lora_marker = any(token in {"lora", "lycoris", "locon", "loha"} for token in tokens)
		index = 0
		while index < len(tokens):
			token = tokens[index]
			if RANK_TOKEN_PATTERN.fullmatch(token):
				result.append("rank")
				changed = True
			elif token in {"rank", "dim"} and index + 1 < len(tokens) and tokens[index + 1].isdigit():
				result.append("rank")
				changed = True
				index += 1
			else:
				result.append(token)
			index += 1
		return tuple(sorted(result)), changed, has_lora_marker

	def path_key(text):
		return str(text or "").strip().replace("\\", "/").lower()

	def basename_path_key(text):
		return path_key(text).rsplit("/", 1)[-1]

	def path_depth(text):
		value = path_key(text)
		return value.count("/") + value.count("\\")

	def model_extension(text):
		lower = str(text or "").strip().lower()
		for ext in sorted(KNOWN_MODEL_EXTENSIONS, key=len, reverse=True):
			if lower.endswith(ext):
				return ext
		return ""

	def note_base_keys(text):
		value = str(text or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
		value = strip_extension(value)
		result = set()
		without_block = NOTE_BLOCK_PATTERN.sub("", value).rstrip(" ._-")
		if without_block and without_block != value:
			result.add(compact_key(without_block))

		tokens = clean_model_key(value, basename_only=True).split()
		trimmed = list(tokens)
		while trimmed and NOTE_TOKEN_PATTERN.fullmatch(trimmed[-1]):
			trimmed.pop()
			if trimmed:
				result.add("".join(trimmed))

		for index, token in enumerate(tokens):
			if index > 0 and CHINESE_PATTERN.search(token):
				prefix = "".join(tokens[:index])
				if len(prefix) >= 8:
					result.add(prefix)
				break
		result.discard("")
		return result

	def score_candidate(query, filename):
		query_ext = model_extension(query)
		candidate_ext = model_extension(filename)
		if query_ext and candidate_ext and query_ext != candidate_ext:
			return 0
		query_key = compact_key(query)
		candidate_key = compact_key(filename)
		if not query_key or not candidate_key:
			return 0
		if candidate_key == query_key:
			return 100000
		if query_key in note_base_keys(filename) or candidate_key in note_base_keys(query):
			return 90000 + min(len(query_key), len(candidate_key))
		return 0

	def loose_suffix_reason(base_key, candidate_key):
		if not base_key or not candidate_key or base_key == candidate_key:
			return ""
		if candidate_key.startswith(base_key):
			suffix = candidate_key[len(base_key):]
		elif base_key.startswith(candidate_key):
			suffix = base_key[len(candidate_key):]
		else:
			return ""
		if suffix in LOOSE_NOTE_SUFFIXES:
			return f"模型主体一致，仅多出备注标记：{suffix}"
		return ""

	def loose_score_candidate(query, filename):
		query_key = compact_key(query)
		candidate_key = compact_key(filename)
		if not query_key or not candidate_key:
			return 0, ""

		query_ext = model_extension(query)
		candidate_ext = model_extension(filename)
		format_changed = bool(query_ext and candidate_ext and query_ext != candidate_ext)
		if query_key == candidate_key:
			reason = "模型主体一致，但文件格式/封装不同" if format_changed else "模型主体一致"
			return 70000, reason

		if query_key in note_base_keys(filename) or candidate_key in note_base_keys(query):
			reason = "模型主体一致，仅多出文件备注"
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 69000 + min(len(query_key), len(candidate_key)), reason

		reason = loose_suffix_reason(query_key, candidate_key)
		if reason:
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 68000 + min(len(query_key), len(candidate_key)), reason

		query_signature = token_signature(query)
		candidate_signature = token_signature(filename)
		if len(query_signature) >= 3 and query_signature == candidate_signature:
			reason = "模型关键词一致，仅排列顺序不同"
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 67000 + min(len(query_key), len(candidate_key)), reason

		query_rank_signature, query_rank_changed, query_has_lora = rank_variant_signature(query)
		candidate_rank_signature, candidate_rank_changed, candidate_has_lora = rank_variant_signature(filename)
		if (
			len(query_rank_signature) >= 3
			and query_rank_signature == candidate_rank_signature
			and (query_rank_changed or candidate_rank_changed)
			and (query_has_lora or candidate_has_lora or (query_rank_changed and candidate_rank_changed))
		):
			reason = "LoRA 主体一致，仅 rank/秩大小不同" if (query_has_lora or candidate_has_lora) else "模型主体一致，仅 rank/秩大小不同"
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 66000 + min(len(query_key), len(candidate_key)), reason
		return 0, ""

	def expand_categories(raw_categories):
		available = set(getattr(folder_paths, "folder_names_and_paths", {}) or {})
		result = []
		def add(name):
			key = str(name or "").strip()
			if key and key in available and key not in result and key not in SKIP_FOLDERS:
				result.append(key)
		for raw in raw_categories or []:
			key = str(raw or "").strip()
			for alias in CATEGORY_ALIASES.get(key, (key,)):
				add(alias)
		if result:
			return result
		for key in available:
			add(key)
		return result

	def find_matches(query, categories, limit=8, allowed_values=None):
		cleaned = clean_model_key(query, basename_only=True)
		if not cleaned:
			return []
		allowed_items = [str(value or "").strip() for value in (allowed_values or []) if str(value or "").strip()]
		allowed = {path_key(value) for value in allowed_items}
		allowed_basenames = {basename_path_key(value) for value in allowed}
		def allowed_rank(filename):
			if not allowed:
				return 0
			key = path_key(filename)
			if key in allowed:
				return 2
			if basename_path_key(filename) in allowed_basenames:
				return 1
			return -1
		def collect(tier):
			scored = []
			if tier == "confirm" and not allowed:
				return []
			def add_scored(category, filename, rank):
				if tier == "strict":
					score = score_candidate(query, filename)
					reason = "严格匹配：仅目录、量化或备注不同"
				else:
					score, reason = loose_score_candidate(query, filename)
				if score <= 0:
					return
				short_len = len(compact_key(filename))
				scored.append((score, rank, path_depth(filename), short_len, str(filename).lower(), category, filename, reason))

			for filename in allowed_items:
				add_scored("widget_options", filename, 3)

			for category in expand_categories(categories):
				try:
					files = list(folder_paths.get_filename_list(category) or [])
				except Exception:
					continue
				for filename in files:
					rank = allowed_rank(filename)
					if rank < 0:
						continue
					add_scored(category, filename, rank)
			scored.sort(key=lambda item: (-item[0], -item[1], item[2], item[3], item[4]))
			seen = set()
			matches = []
			for score, _rank, _depth, _short_len, _lower, category, filename, reason in scored:
				key = (category, filename)
				if key in seen:
					continue
				seen.add(key)
				matches.append({
					"category": category,
					"name": filename,
					"score": score,
					"tier": tier,
					"needs_confirmation": tier == "confirm",
					"reason": reason,
					"cleaned_name": clean_model_key(filename, basename_only=True),
				})
				if len(matches) >= limit:
					break
			return matches

		strict_matches = collect("strict")
		if strict_matches:
			return strict_matches
		return collect("confirm")

	@server.routes.post("/gjj/summon_model")
	async def gjj_summon_model(request):
		try:
			data = await request.json()
		except Exception:
			data = {}
		raw_queries = data.get("queries")
		if not isinstance(raw_queries, list):
			raw_queries = [data]
		results = []
		for item in raw_queries:
			if not isinstance(item, dict):
				item = {}
			query = str(item.get("value") or item.get("query") or "").strip()
			categories = item.get("categories") or []
			allowed_values = item.get("allowed_values") or []
			limit = int(item.get("limit") or 8)
			matches = find_matches(query, categories, limit=max(1, min(limit, 30)), allowed_values=allowed_values)
			results.append({
				"id": item.get("id"),
				"widget_name": item.get("widget_name"),
				"source_value": query,
				"cleaned_query": clean_model_key(query, basename_only=True),
				"categories": expand_categories(categories),
				"ok": bool(matches),
				"match": matches[0] if matches else None,
				"matches": matches,
			})
		return web.json_response({"results": results})

	server._gjj_summon_model_api_registered = True
_register_gjj_summon_model_api()
