import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.Settings";
	const SETTING_IDS = Object.freeze({
		summonModelMenu: "GJJ.SummonModel.Menu.Enabled",
		summonModelConfirmSecondTier: "GJJ.SummonModel.SecondTierConfirm.Enabled",
		nodeArrangerMenu: "GJJ.NodeArranger.Menu.Enabled",
		executionTimerEnabled: "GJJ.ExecutionTimer.Enabled",
		executionTimerNewestFirst: "GJJ.ExecutionTimer.NewestFirst",
		executionTimerCollapsed: "GJJ.ExecutionTimer.Collapsed",
		executionTimerResetPosition: "GJJ.ExecutionTimer.ResetPosition",
	});
	const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
	const GJJ_SETTINGS_ICON_SVG = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="#f4ea2a" d="M811.707 1024H212.293C94.907 1024 0 929.093 0 811.707V212.293C0 94.907 94.907 0 212.293 0h599.414C929.093 0 1024 94.907 1024 212.293v599.414C1024 929.093 929.093 1024 811.707 1024ZM212.293 24.976c-102.4 0-187.317 84.917-187.317 187.317v599.414c0 102.4 84.917 187.317 187.317 187.317h599.414c102.4 0 187.317-84.917 187.317-187.317V212.293c0-102.4-84.917-187.317-187.317-187.317H212.293Z"/><path fill="#1afa29" d="M512 634.38V489.522h374.634v342.166c-37.463 34.966-89.912 64.937-157.346 92.41-67.434 27.472-139.863 39.96-209.795 39.96-89.912 0-167.337-19.98-234.771-57.444-67.434-37.463-117.385-92.41-149.854-162.341-32.468-69.932-49.951-147.356-49.951-229.776 0-89.912 17.483-169.834 54.946-237.268 37.464-67.434 92.41-122.381 164.839-159.844 54.947-27.473 122.381-42.458 204.8-42.458 107.395 0 189.815 22.478 249.756 67.434 29.971 22.478 52.449 47.454 72.43 77.424 19.98 32.469 169.834 0 177.326 42.459l-307.2 99.902c-12.488-42.458-34.966-74.927-67.434-99.902-32.469-24.976-74.927-37.464-124.878-37.464-74.927 0-134.868 24.976-179.824 72.43-44.956 47.453-67.434 119.882-67.434 214.79 0 102.4 22.478 177.326 67.434 229.775 44.956 52.449 104.898 77.424 177.327 77.424 37.463 0 72.429-7.492 109.892-22.478 37.464-14.985 67.434-32.468 94.908-52.449V634.38H512Z"/></svg>`;
	const GJJ_SETTINGS_ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(GJJ_SETTINGS_ICON_SVG)}`;

	function getSettings() {
		return app?.ui?.settings || null;
	}

	function getSettingValue(id, fallback = undefined) {
		const settings = getSettings();
		try {
			const value = settings?.getSettingValue?.(id);
			return value === undefined ? fallback : value;
		} catch (_) {
			return fallback;
		}
	}

	function settingExists(settings, id) {
		if (!settings) return false;
		if (settings.settingsLookup?.[id]) return true;
		if (settings.settings?.some?.((item) => item?.id === id)) return true;
		return false;
	}

	function addSetting(settings, setting) {
		if (!settings?.addSetting || settingExists(settings, setting.id)) return;
		settings.addSetting(setting);
	}

	function makeSettingsIcon(size = 18) {
		const image = document.createElement("img");
		image.src = GJJ_SETTINGS_ICON_URL;
		image.alt = "";
		image.width = size;
		image.height = size;
		image.className = "gjj-settings-category-icon";
		image.style.cssText = `width:${size}px;height:${size}px;object-fit:contain;flex:0 0 ${size}px`;
		return image;
	}

	function decorateSettingsCategory(root = document) {
		const categoryRows = [
			...(root.matches?.('[data-nav-id="root/GJJ"]') ? [root] : []),
			...(root.querySelectorAll?.('[data-nav-id="root/GJJ"]') || []),
		];
		for (const row of categoryRows) {
			if (row.querySelector(".gjj-settings-category-icon")) continue;
			const oldIcon = row.querySelector("i,svg");
			if (oldIcon) oldIcon.style.display = "none";
			const label = Array.from(row.querySelectorAll("span")).find((item) => item.textContent?.trim() === "GJJ");
			(label || row.firstChild)?.before?.(makeSettingsIcon(18));
			row.dataset.gjjSettingsCategory = "true";
		}

		const selector = "span,div,p,h1,h2,h3";
		const textNodes = [
			...(root.matches?.(selector) ? [root] : []),
			...(root.querySelectorAll?.(selector) || []),
		];
		for (const textNode of textNodes) {
			if (textNode.children.length || textNode.textContent?.trim() !== "GJJ") continue;

			const row = textNode.closest("button,[role='button'],[role='tab'],[role='menuitem'],li,a");
			if (row && !row.querySelector(".gjj-settings-category-icon")) {
				const oldIcon = row.querySelector("svg,i");
				if (oldIcon) oldIcon.style.display = "none";
				textNode.before(makeSettingsIcon(18));
				row.dataset.gjjSettingsCategory = "true";
				continue;
			}

			if (/^H[1-3]$/.test(textNode.tagName) && !textNode.querySelector(".gjj-settings-category-icon")) {
				textNode.prepend(makeSettingsIcon(24));
				textNode.style.display = "flex";
				textNode.style.alignItems = "center";
				textNode.style.gap = "10px";
			}
		}
	}

	function installSettingsCategoryIcon() {
		if (!document.getElementById("gjj-settings-category-icon-style")) {
			const style = document.createElement("style");
			style.id = "gjj-settings-category-icon-style";
			style.textContent = `
				[data-nav-id="root/GJJ"] > i,
				[data-nav-id="GJJ"] > i {
					display: none !important;
				}
				[data-nav-id="root/GJJ"]::before,
				[data-nav-id="GJJ"]::before {
					content: "";
					width: 18px;
					height: 18px;
					flex: 0 0 18px;
					background: center / contain no-repeat url("${GJJ_SETTINGS_ICON_URL}");
				}
				[data-nav-id="root/GJJ"]:has(> .gjj-settings-category-icon)::before,
				[data-nav-id="GJJ"]:has(> .gjj-settings-category-icon)::before {
					display: none;
				}
			`;
			document.head.append(style);
		}
		decorateSettingsCategory();
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) decorateSettingsCategory(node);
				}
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
	}

	function registerSettings() {
		const settings = getSettings();
		if (!settings?.addSetting) return false;

		addSetting(settings, {
			id: SETTING_IDS.summonModelMenu,
			name: "右键菜单显示「召唤模型」",
			category: ["GJJ", "模型工具", "召唤模型"],
			tooltip: "选中缺失模型节点时，在节点右键菜单里显示「召唤模型」。",
			type: "boolean",
			defaultValue: true,
		});

		addSetting(settings, {
			id: SETTING_IDS.summonModelConfirmSecondTier,
			name: "第二梯队候选替换前确认",
			category: ["GJJ", "模型工具", "第二梯队确认"],
			tooltip: "当候选只是格式、量化、封装或文件备注相近时，替换前弹窗确认。",
			type: "boolean",
			defaultValue: true,
		});

		addSetting(settings, {
			id: SETTING_IDS.nodeArrangerMenu,
			name: "右键菜单显示「GJJ 节点排列」",
			category: ["GJJ", "画布工具", "节点排列"],
			tooltip: "在画布右键菜单里显示 GJJ 节点排列工具。",
			type: "boolean",
			defaultValue: true,
		});

		addSetting(settings, {
			id: SETTING_IDS.executionTimerEnabled,
			name: "启用 GJJ 计时器",
			category: ["GJJ", "系统工具", "计时器"],
			tooltip: "工作流执行时显示 GJJ 计时器面板。",
			type: "boolean",
			defaultValue: true,
			onChange: (value) => globalThis.GJJ_CommonExecutionTimer?.setSettings?.({ enabled: Boolean(value) }),
		});

		addSetting(settings, {
			id: SETTING_IDS.executionTimerNewestFirst,
			name: "计时记录最新项显示在顶部",
			category: ["GJJ", "系统工具", "计时器顺序"],
			tooltip: "关闭时按执行顺序从上到下显示。",
			type: "boolean",
			defaultValue: false,
			onChange: (value) => globalThis.GJJ_CommonExecutionTimer?.setSettings?.({ newest_first: Boolean(value) }),
		});

		addSetting(settings, {
			id: SETTING_IDS.executionTimerCollapsed,
			name: "计时器默认折叠",
			category: ["GJJ", "系统工具", "计时器折叠"],
			tooltip: "此状态也会在计时器面板的折叠按钮操作后写入用户设置文件。",
			type: "boolean",
			defaultValue: false,
			onChange: (value) => globalThis.GJJ_CommonExecutionTimer?.setSettings?.({ collapsed: Boolean(value) }),
		});

		addSetting(settings, {
			id: SETTING_IDS.executionTimerResetPosition,
			name: "计时器恢复右下角位置",
			category: ["GJJ", "系统工具", "计时器位置"],
			tooltip: "开启一次即可清除已保存的拖动坐标；完成后会自动关闭此开关。",
			type: "boolean",
			defaultValue: false,
			onChange: async (value) => {
				if (!value) return;
				await globalThis.GJJ_CommonExecutionTimer?.resetPosition?.();
				try { settings.setSettingValue?.(SETTING_IDS.executionTimerResetPosition, false); } catch (_) {}
			},
		});

		globalThis.GJJ_Settings = {
			ids: SETTING_IDS,
			get: getSettingValue,
			bool(id, fallback = false) {
				return Boolean(getSettingValue(id, fallback));
			},
		};
		return true;
	}

	async function syncTimerSettingsToPanel() {
		const settings = getSettings();
		if (!settings) return;
		try {
			const response = await fetch(USER_SETTINGS_ENDPOINT);
			if (!response.ok) return;
			const values = (await response.json())?.settings?.execution_timer || {};
			settings.setSettingValue?.(SETTING_IDS.executionTimerEnabled, values.enabled !== false);
			settings.setSettingValue?.(SETTING_IDS.executionTimerNewestFirst, values.newest_first === true);
			settings.setSettingValue?.(SETTING_IDS.executionTimerCollapsed, values.collapsed === true);
			settings.setSettingValue?.(SETTING_IDS.executionTimerResetPosition, false);
		} catch (_) {}
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			installSettingsCategoryIcon();
			let attempts = 0;
			const tryRegister = () => {
				attempts += 1;
				if (registerSettings()) {
					void syncTimerSettingsToPanel();
				} else if (attempts < 10) {
					setTimeout(tryRegister, 300);
				}
			};
			tryRegister();
		},
	});
})();
