import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.Settings";
	const SETTING_IDS = Object.freeze({
		summonModelMenu: "GJJ.SummonModel.Menu.Enabled",
		summonModelConfirmSecondTier: "GJJ.SummonModel.SecondTierConfirm.Enabled",
		nodeArrangerMenu: "GJJ.NodeArranger.Menu.Enabled",
	});

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

		globalThis.GJJ_Settings = {
			ids: SETTING_IDS,
			get: getSettingValue,
			bool(id, fallback = false) {
				return Boolean(getSettingValue(id, fallback));
			},
		};
		return true;
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			let attempts = 0;
			const tryRegister = () => {
				attempts += 1;
				if (!registerSettings() && attempts < 10) {
					setTimeout(tryRegister, 300);
				}
			};
			tryRegister();
		},
	});
})();
