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
