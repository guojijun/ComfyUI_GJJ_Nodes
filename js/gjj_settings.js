import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

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
		queueFinishEnabled: "GJJ.QueueFinishCommand.Enabled",
		queueFinishAction: "GJJ.QueueFinishCommand.Action",
		queueFinishCustomCommand: "GJJ.QueueFinishCommand.CustomCommand",
		queueFinishDelaySeconds: "GJJ.QueueFinishCommand.DelaySeconds",
		queueFinishOnlyOnSuccess: "GJJ.QueueFinishCommand.OnlyOnSuccess",
		queueFinishAudioFile: "GJJ.QueueFinishCommand.AudioFile",
		queueFinishSmtpHost: "GJJ.QueueFinishCommand.SmtpHost",
		queueFinishSmtpPort: "GJJ.QueueFinishCommand.SmtpPort",
		queueFinishSmtpSecurity: "GJJ.QueueFinishCommand.SmtpSecurity",
		queueFinishSmtpUsername: "GJJ.QueueFinishCommand.SmtpUsername",
		queueFinishSmtpPassword: "GJJ.QueueFinishCommand.SmtpPassword",
		queueFinishMailFrom: "GJJ.QueueFinishCommand.MailFrom",
		queueFinishMailTo: "GJJ.QueueFinishCommand.MailTo",
		queueFinishMailSubject: "GJJ.QueueFinishCommand.MailSubject",
		queueFinishMailBody: "GJJ.QueueFinishCommand.MailBody",
	});
	const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
	const QUEUE_FINISH_SECTION = "queue_finish_command";
	const QUEUE_FINISH_RUN_ENDPOINT = "/gjj/queue_finish_command/run";
	const QUEUE_FINISH_ACTIONS = Object.freeze([
		{ value: "none", text: "不执行任何操作" },
		{ value: "shutdown", text: "关机" },
		{ value: "sleep", text: "睡眠" },
		{ value: "hibernate", text: "休眠（Hibernate）" },
		{ value: "audio", text: "播放音频" },
		{ value: "email", text: "发送邮件" },
		{ value: "custom", text: "自定义系统命令" },
		{ value: "close_comfyui", text: "关闭 ComfyUI" },
	]);
	const SMTP_SECURITY_OPTIONS = Object.freeze([
		{ value: "ssl", text: "SSL/TLS" },
		{ value: "starttls", text: "STARTTLS" },
		{ value: "none", text: "不加密" },
	]);
	let queueFinishSaveTimer = null;
	let queueFinishRunTimer = null;
	let queueFinishArmed = false;
	let queueFinishHadError = false;
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

	function queueFinishValues() {
		return {
			enabled: Boolean(getSettingValue(SETTING_IDS.queueFinishEnabled, false)),
			action: String(getSettingValue(SETTING_IDS.queueFinishAction, "none") || "none"),
			custom_command: String(getSettingValue(SETTING_IDS.queueFinishCustomCommand, "") || ""),
			delay_seconds: Math.max(0, Math.min(3600, Number(getSettingValue(SETTING_IDS.queueFinishDelaySeconds, 10)) || 0)),
			only_on_success: Boolean(getSettingValue(SETTING_IDS.queueFinishOnlyOnSuccess, true)),
			audio_file: String(getSettingValue(SETTING_IDS.queueFinishAudioFile, "") || ""),
			smtp_host: String(getSettingValue(SETTING_IDS.queueFinishSmtpHost, "") || ""),
			smtp_port: Math.max(1, Math.min(65535, Number(getSettingValue(SETTING_IDS.queueFinishSmtpPort, 465)) || 465)),
			smtp_security: String(getSettingValue(SETTING_IDS.queueFinishSmtpSecurity, "ssl") || "ssl"),
			smtp_username: String(getSettingValue(SETTING_IDS.queueFinishSmtpUsername, "") || ""),
			smtp_password: String(getSettingValue(SETTING_IDS.queueFinishSmtpPassword, "") || ""),
			mail_from: String(getSettingValue(SETTING_IDS.queueFinishMailFrom, "") || ""),
			mail_to: String(getSettingValue(SETTING_IDS.queueFinishMailTo, "") || ""),
			mail_subject: String(getSettingValue(SETTING_IDS.queueFinishMailSubject, "ComfyUI 队列已完成") || ""),
			mail_body: String(getSettingValue(SETTING_IDS.queueFinishMailBody, "ComfyUI 队列已全部执行完成。") || ""),
		};
	}

	function saveQueueFinishSettingsSoon() {
		clearTimeout(queueFinishSaveTimer);
		queueFinishSaveTimer = setTimeout(() => {
			fetch(USER_SETTINGS_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ section: QUEUE_FINISH_SECTION, values: queueFinishValues() }),
			}).catch((error) => console.warn("[GJJ] 保存队列完成命令设置失败：", error));
		}, 150);
	}

	async function queueIsEmpty() {
		const response = await fetch("/queue");
		if (!response.ok) return false;
		const data = await response.json();
		return (data?.queue_running?.length || 0) === 0 && (data?.queue_pending?.length || 0) === 0;
	}

	function cancelQueueFinishRun() {
		clearTimeout(queueFinishRunTimer);
		queueFinishRunTimer = null;
	}

	function scheduleQueueFinishRun() {
		cancelQueueFinishRun();
		if (!queueFinishArmed) return;
		const values = queueFinishValues();
		if (!values.enabled) {
			queueFinishArmed = false;
			return;
		}
		queueFinishRunTimer = setTimeout(async () => {
			queueFinishRunTimer = null;
			try {
				if (!queueFinishArmed || !(await queueIsEmpty())) return;
				if (values.only_on_success && queueFinishHadError) {
					queueFinishArmed = false;
					queueFinishHadError = false;
					return;
				}
				queueFinishArmed = false;
				queueFinishHadError = false;
				const response = await fetch(QUEUE_FINISH_RUN_ENDPOINT, { method: "POST" });
				if (!response.ok) {
					const data = await response.json().catch(() => ({}));
					throw new Error(data?.error || `HTTP ${response.status}`);
				}
			} catch (error) {
				console.warn("[GJJ] 队列完成命令触发失败：", error);
			}
		}, values.delay_seconds * 1000);
	}

	function installQueueFinishListeners() {
		if (globalThis.__gjjQueueFinishCommandReady) return;
		globalThis.__gjjQueueFinishCommandReady = true;
		api.addEventListener("execution_start", () => {
			cancelQueueFinishRun();
			if (!queueFinishArmed) queueFinishHadError = false;
			queueFinishArmed = true;
		});
		for (const eventName of ["execution_error", "execution_interrupted"]) {
			api.addEventListener(eventName, () => {
				queueFinishHadError = true;
				setTimeout(scheduleQueueFinishRun, 500);
			});
		}
		api.addEventListener("execution_success", () => setTimeout(scheduleQueueFinishRun, 500));
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

	function showSettingsContentBadge(row) {
		document.querySelectorAll(".gjj-settings-content-badge").forEach((item) => item.remove());
		const dialog = row?.closest?.("[role='dialog'], .p-dialog, .comfyui-body-left, body") || document.body;
		const badge = makeSettingsIcon(48);
		badge.className = "gjj-settings-content-badge";
		badge.title = "GJJ 设置";
		dialog.appendChild(badge);
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
				.gjj-settings-content-badge {
					position: absolute;
					top: 26px;
					right: 74px;
					z-index: 20;
					width: 48px !important;
					height: 48px !important;
					filter: drop-shadow(0 2px 7px rgba(26,250,41,.28));
					pointer-events: none;
				}
			`;
			document.head.append(style);
		}
		document.addEventListener("click", (event) => {
			const row = event.target?.closest?.("[data-nav-id]");
			if (!row) return;
			const navId = String(row.dataset.navId || "");
			if (navId === "root/GJJ" || navId === "GJJ") {
				requestAnimationFrame(() => showSettingsContentBadge(row));
			} else {
				document.querySelectorAll(".gjj-settings-content-badge").forEach((item) => item.remove());
			}
		}, true);
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

		addSetting(settings, {
			id: SETTING_IDS.queueFinishEnabled,
			name: "队列全部完成后执行系统命令",
			category: ["GJJ", "系统工具", "队列完成命令"],
			tooltip: "默认关闭。只有本页面观察到队列执行，并确认运行中、待运行队列都为空后才会触发。",
			type: "boolean",
			defaultValue: false,
			onChange: (value) => {
				if (!value) cancelQueueFinishRun();
				saveQueueFinishSettingsSoon();
			},
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishAction,
			name: "队列完成后的操作",
			category: ["GJJ", "系统工具", "队列完成操作"],
			tooltip: "默认不执行任何操作。也可选择关闭 ComfyUI、关机、睡眠、休眠、播放音频、发送邮件或自定义命令。",
			type: "combo",
			defaultValue: "none",
			options: (value) => QUEUE_FINISH_ACTIONS.map((item) => ({ ...item, selected: item.value === value })),
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishCustomCommand,
			name: "自定义系统命令",
			category: ["GJJ", "系统工具", "自定义命令"],
			tooltip: "仅当上方操作选择“自定义系统命令”时使用。命令以 ComfyUI 当前用户权限运行。",
			type: "text",
			defaultValue: "",
			attrs: { placeholder: "例如：python D:\\scripts\\done.py" },
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishDelaySeconds,
			name: "执行前等待秒数",
			category: ["GJJ", "系统工具", "命令延迟"],
			tooltip: "等待期间如果开始了新任务，本次命令会取消。范围 0～3600 秒。",
			type: "number",
			defaultValue: 10,
			attrs: { min: 0, max: 3600, step: 1 },
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishOnlyOnSuccess,
			name: "仅在队列全部成功时执行",
			category: ["GJJ", "系统工具", "仅成功执行"],
			tooltip: "开启后，只要本轮队列发生报错或被中断，就不会执行系统命令。",
			type: "boolean",
			defaultValue: true,
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishAudioFile,
			name: "完成提示音频文件",
			category: ["GJJ", "系统工具", "播放音频"],
			tooltip: "“播放音频”操作使用的本地文件路径。Windows 使用默认播放器，macOS 使用 afplay，Linux 使用 ffplay。",
			type: "text",
			defaultValue: "",
			attrs: { placeholder: "例如：D:\\Sounds\\complete.mp3" },
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishSmtpHost,
			name: "SMTP 服务器",
			category: ["GJJ", "系统工具", "邮件服务器"],
			tooltip: "“发送邮件”操作使用的 SMTP 服务器地址。",
			type: "text",
			defaultValue: "",
			attrs: { placeholder: "例如：smtp.qq.com" },
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishSmtpPort,
			name: "SMTP 端口",
			category: ["GJJ", "系统工具", "邮件端口"],
			type: "number",
			defaultValue: 465,
			attrs: { min: 1, max: 65535, step: 1 },
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishSmtpSecurity,
			name: "SMTP 加密方式",
			category: ["GJJ", "系统工具", "邮件加密"],
			type: "combo",
			defaultValue: "ssl",
			options: (value) => SMTP_SECURITY_OPTIONS.map((item) => ({ ...item, selected: item.value === value })),
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishSmtpUsername,
			name: "SMTP 用户名",
			category: ["GJJ", "系统工具", "邮件账号"],
			type: "text",
			defaultValue: "",
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishSmtpPassword,
			name: "SMTP 密码或授权码",
			category: ["GJJ", "系统工具", "邮件凭据"],
			tooltip: "保存在 GJJ 本地用户设置文件中，请使用邮箱提供的应用授权码。",
			type: "text",
			defaultValue: "",
			attrs: { type: "password", autocomplete: "new-password" },
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishMailFrom,
			name: "邮件发件人",
			category: ["GJJ", "系统工具", "邮件发件人"],
			tooltip: "留空时使用 SMTP 用户名。",
			type: "text",
			defaultValue: "",
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishMailTo,
			name: "邮件收件人",
			category: ["GJJ", "系统工具", "邮件收件人"],
			tooltip: "多个收件人使用英文逗号或分号分隔。",
			type: "text",
			defaultValue: "",
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishMailSubject,
			name: "邮件主题",
			category: ["GJJ", "系统工具", "邮件主题"],
			type: "text",
			defaultValue: "ComfyUI 队列已完成",
			onChange: saveQueueFinishSettingsSoon,
		});

		addSetting(settings, {
			id: SETTING_IDS.queueFinishMailBody,
			name: "邮件正文",
			category: ["GJJ", "系统工具", "邮件正文"],
			type: "text",
			defaultValue: "ComfyUI 队列已全部执行完成。",
			onChange: saveQueueFinishSettingsSoon,
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
			const allSettings = (await response.json())?.settings || {};
			const values = allSettings.execution_timer || {};
			settings.setSettingValue?.(SETTING_IDS.executionTimerEnabled, values.enabled !== false);
			settings.setSettingValue?.(SETTING_IDS.executionTimerNewestFirst, values.newest_first === true);
			settings.setSettingValue?.(SETTING_IDS.executionTimerCollapsed, values.collapsed === true);
			settings.setSettingValue?.(SETTING_IDS.executionTimerResetPosition, false);
			const queueValues = allSettings[QUEUE_FINISH_SECTION] || {};
			settings.setSettingValue?.(SETTING_IDS.queueFinishEnabled, queueValues.enabled === true);
			settings.setSettingValue?.(SETTING_IDS.queueFinishAction, queueValues.action || "none");
			settings.setSettingValue?.(SETTING_IDS.queueFinishCustomCommand, queueValues.custom_command || "");
			settings.setSettingValue?.(SETTING_IDS.queueFinishDelaySeconds, Number(queueValues.delay_seconds ?? 10));
			settings.setSettingValue?.(SETTING_IDS.queueFinishOnlyOnSuccess, queueValues.only_on_success !== false);
			settings.setSettingValue?.(SETTING_IDS.queueFinishAudioFile, queueValues.audio_file || "");
			settings.setSettingValue?.(SETTING_IDS.queueFinishSmtpHost, queueValues.smtp_host || "");
			settings.setSettingValue?.(SETTING_IDS.queueFinishSmtpPort, Number(queueValues.smtp_port ?? 465));
			settings.setSettingValue?.(SETTING_IDS.queueFinishSmtpSecurity, queueValues.smtp_security || "ssl");
			settings.setSettingValue?.(SETTING_IDS.queueFinishSmtpUsername, queueValues.smtp_username || "");
			settings.setSettingValue?.(SETTING_IDS.queueFinishSmtpPassword, queueValues.smtp_password || "");
			settings.setSettingValue?.(SETTING_IDS.queueFinishMailFrom, queueValues.mail_from || "");
			settings.setSettingValue?.(SETTING_IDS.queueFinishMailTo, queueValues.mail_to || "");
			settings.setSettingValue?.(SETTING_IDS.queueFinishMailSubject, queueValues.mail_subject || "ComfyUI 队列已完成");
			settings.setSettingValue?.(SETTING_IDS.queueFinishMailBody, queueValues.mail_body || "ComfyUI 队列已全部执行完成。");
		} catch (_) {}
	}

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			installSettingsCategoryIcon();
			installQueueFinishListeners();
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
