import { GJJ_Utils } from "./gjj_utils.js";
(() => {
	function normalizeText(value) {
		return String(value || "").trim().toLowerCase();
	}

	function canonicalizeText(value) {
		return normalizeText(value).replace(/[\\/_\-\.\s]+/g, "");
	}

	function parseQuery(query) {
		const normalized = normalizeText(query);
		if (!normalized) {
			return [];
		}
		return normalized
			.split(/\s+/)
			.map((term) => term.split(",").map((token) => canonicalizeText(token)).filter(Boolean))
			.filter((group) => group.length > 0);
	}

	function fuzzyTokenMatch(text, canonicalText, token) {
		if (!token) {
			return true;
		}
		if (text.includes(token) || canonicalText.includes(token)) {
			return true;
		}
		let pointer = 0;
		for (const char of canonicalText) {
			if (char === token[pointer]) {
				pointer += 1;
				if (pointer >= token.length) {
					return true;
				}
			}
		}
		return false;
	}

	function matchesQuery(text, query) {
		const groups = Array.isArray(query) ? query : parseQuery(query);
		if (!groups.length) {
			return true;
		}
		const normalizedText = normalizeText(text);
		const canonicalText = canonicalizeText(text);
		return groups.every((group) => group.some((token) => fuzzyTokenMatch(normalizedText, canonicalText, token)));
	}

	function filterValues(values, query, currentValue = "") {
		const list = Array.isArray(values) ? values.map((item) => String(item ?? "")) : [];
		const filtered = list.filter((item) => matchesQuery(item, query));
		const current = String(currentValue ?? "");
		if (current && !filtered.includes(current) && list.includes(current)) {
			filtered.unshift(current);
		}
		return filtered.length ? filtered : (current ? [current] : list.slice(0, 1));
	}

	globalThis.GJJSearchUtils = {
		normalizeText,
		canonicalizeText,
		parseQuery,
		matchesQuery,
		filterValues,
	};
})();
