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
