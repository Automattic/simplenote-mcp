/**
 * Shared normalization helpers and the provider interface contract.
 *
 * Every provider's loadStore() must return { notes, tags } in the shape below.
 * The tool handlers in server.js consume this shape directly — they do not
 * know which provider produced it.
 *
 * @typedef {Object} Note
 * @property {string} id         Simperium key.
 * @property {string} content    Full note body.
 * @property {string[]} tags     Tag names.
 * @property {boolean} pinned
 * @property {boolean} markdown
 * @property {boolean} deleted
 * @property {string|null} created   ISO 8601 string.
 * @property {string|null} modified  ISO 8601 string.
 *
 * @typedef {Object} Tag
 * @property {string} name
 * @property {number} index
 *
 * @typedef {Object} Store
 * @property {Note[]} notes
 * @property {Tag[]} tags
 *
 * @typedef {Object} Provider
 * @property {() => Promise<Store>} loadStore
 */

/**
 * First non-empty line of the content, truncated to 100 chars. Used as a
 * display title since Simplenote notes don't have a dedicated title field.
 */
export function extractTitle(content) {
	if (!content || typeof content !== 'string') {
		return '(empty)';
	}
	const firstLine = content.split('\n')[0]?.trim();
	return firstLine?.slice(0, 100) || '(empty)';
}

/**
 * Parse a JSON array string, returning defaultValue when parsing fails or the
 * result isn't an array. Simplenote stores tag lists as JSON strings.
 */
export function safeJsonParse(str, defaultValue = []) {
	if (!str || typeof str !== 'string') {
		return defaultValue;
	}
	try {
		const parsed = JSON.parse(str);
		return Array.isArray(parsed) ? parsed : defaultValue;
	} catch {
		return defaultValue;
	}
}

/**
 * Convert a Unix timestamp (seconds since epoch, may be fractional) to an ISO
 * string. Returns null on missing or invalid input.
 */
export function unixSecondsToIso(seconds) {
	if (seconds === null || seconds === undefined || seconds === '') {
		return null;
	}
	const n = typeof seconds === 'number' ? seconds : parseFloat(seconds);
	if (Number.isNaN(n)) {
		return null;
	}
	return new Date(n * 1000).toISOString();
}
