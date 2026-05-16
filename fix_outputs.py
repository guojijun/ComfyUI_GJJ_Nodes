import re

filepath = r'd:\AI\CUI77\ComfyUI\custom_nodes\GJJ\js\gjj_multi_video_loader.js'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

old_func = '''function applyDynamicOutputs(node) {
	if (!node) return;
	const state = ensureState(node);

	// 后端已声明固定的10个输出，这里只需要同步显示状态
	// 第一个输出始终显示
	if (node.outputs?.[0]) {
		node.outputs[0].name = "视频帧队列";
		node.outputs[0].label = "视频帧队列";
		node.outputs[0].localized_name = "视频帧队列";
		node.outputs[0].type = BATCH_IMAGE_TYPE;
		node.outputs[0].visible = true;
	}

	// 同步其他输出的可见性
	let outputIndex = 1;
	for (const def of OUTPUT_DEFS) {
		const output = node.outputs?.[outputIndex];
		if (output) {
			output.name = def.name;
			output.label = def.name;
			output.localized_name = def.name;
			output.type = def.type;
			output.visible = state.enabledOutputs.includes(def.key);
			output.__gjj_key = def.key;
		}
		outputIndex++;
	}

	globalThis.GJJApplyTypeColorsToNode?.(node);
}'''

new_func = '''function applyDynamicOutputs(node) {
	if (!node) return;
	const state = ensureState(node);
	const firstName = "视频帧队列";

	if (!node.outputs || node.outputs.length === 0) {
		node.addOutput?.(firstName, BATCH_IMAGE_TYPE);
	}

	while ((node.outputs?.length || 0) > 1) {
		node.removeOutput?.(node.outputs.length - 1);
	}

	if (node.outputs?.[0]) {
		node.outputs[0].name = firstName;
		node.outputs[0].label = firstName;
		node.outputs[0].localized_name = firstName;
		node.outputs[0].type = BATCH_IMAGE_TYPE;
	}

	for (const key of state.enabledOutputs) {
		const def = OUTPUT_DEFS.find((item) => item.key === key);
		if (!def) continue;
		node.addOutput?.(def.name, def.type);
		const output = node.outputs?.[node.outputs.length - 1];
		if (output) {
			output.name = def.name;
			output.label = def.name;
			output.localized_name = def.name;
			output.type = def.type;
			output.__gjj_key = def.key;
		}
	}

	globalThis.GJJApplyTypeColorsToNode?.(node);
}'''

if old_func in content:
    content = content.replace(old_func, new_func)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print('File updated successfully')
else:
    print('Pattern not found - checking for variations...')
    # Try to find similar pattern
    if 'function applyDynamicOutputs' in content:
        print('Found function but pattern mismatch')
    else:
        print('Function not found at all')