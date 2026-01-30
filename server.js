#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

// Parse CLI arguments for custom store path
function getStorePath() {
	const args = process.argv.slice(2);
	const pathIndex = args.indexOf('--path');
	if (pathIndex !== -1 && args[pathIndex + 1]) {
		return args[pathIndex + 1];
	}
	// Default macOS Simplenote location
	return `${homedir()}/Library/Group Containers/PZYM8XX95Q.com.automattic.SimplenoteMac/Data/Simplenote.storedata`;
}

const STORE_PATH = getStorePath();

// Cache for parsed data
let cache = {
	mtime: null,
	data: null,
};

/**
 * Load and parse the Simplenote store, with caching based on file modification time.
 * @returns {{ notes: Array, tags: Array }}
 */
function loadStore() {
	let currentMtime;

	try {
		const stats = statSync(STORE_PATH);
		currentMtime = stats.mtimeMs;
	} catch (err) {
		throw new Error(
			`Simplenote store not found at ${STORE_PATH}. Is Simplenote installed?`
		);
	}

	// Return cached data if file hasn't changed
	if (cache.mtime === currentMtime && cache.data) {
		return cache.data;
	}

	let xml;
	try {
		xml = readFileSync(STORE_PATH, 'utf-8');
	} catch (err) {
		throw new Error(`Failed to read Simplenote store: ${err.message}`);
	}

	let db;
	try {
		const parser = new XMLParser({ ignoreAttributes: false });
		db = parser.parse(xml);
	} catch (err) {
		throw new Error(`Failed to parse Simplenote data: ${err.message}`);
	}

	const objects = db.database?.object || [];
	const objectList = Array.isArray(objects) ? objects : [objects];

	const notes = objectList.filter((obj) => obj['@_type'] === 'NOTE');
	const tags = objectList.filter((obj) => obj['@_type'] === 'TAG');

	cache = {
		mtime: currentMtime,
		data: { notes, tags },
	};

	return cache.data;
}

/**
 * Get an attribute value from a Core Data object.
 */
function getAttr(obj, name) {
	if (!obj?.attribute) {
		return null;
	}
	const attrs = Array.isArray(obj.attribute) ? obj.attribute : [obj.attribute];
	const attr = attrs.find((a) => a?.['@_name'] === name);
	return attr?.['#text'] ?? null;
}

/**
 * Safely parse JSON array, returning default value on failure or non-array result.
 */
function safeJsonParse(str, defaultValue = []) {
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
 * Convert Core Data timestamp to ISO date string.
 * Core Data uses seconds since January 1, 2001.
 */
function convertDate(coreDataTimestamp) {
	if (!coreDataTimestamp) {
		return null;
	}
	const parsed = parseFloat(coreDataTimestamp);
	if (Number.isNaN(parsed)) {
		return null;
	}
	const unix = parsed + 978307200;
	return new Date(unix * 1000).toISOString();
}

/**
 * Extract title from note content (first line, truncated).
 */
function extractTitle(content) {
	if (!content || typeof content !== 'string') {
		return '(empty)';
	}
	const firstLine = content.split('\n')[0]?.trim();
	return firstLine?.slice(0, 100) || '(empty)';
}

// Create MCP server
const server = new McpServer({
	name: 'simplenote',
	version: '1.0.0',
});

// Tool: list_tags
server.tool('list_tags', 'List all tags in SimpleNote', {}, async () => {
	try {
		const { tags } = loadStore();

		const result = tags
			.map((obj) => ({
				name: getAttr(obj, 'name'),
				index: parseInt(getAttr(obj, 'index') || '0', 10),
			}))
			.filter((t) => t.name) // Filter out any with missing names
			.sort((a, b) => a.index - b.index);

		return {
			content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
		};
	} catch (err) {
		return {
			content: [{ type: 'text', text: `Error: ${err.message}` }],
			isError: true,
		};
	}
});

// Tool: list_notes
server.tool(
	'list_notes',
	'List recent notes, optionally filtered by tag',
	{
		tag: z.string().optional().describe('Filter by tag name'),
		limit: z.number().optional().default(20).describe('Max notes to return'),
	},
	async ({ tag, limit }) => {
		try {
			const { notes } = loadStore();

			const result = notes
				.filter((obj) => getAttr(obj, 'deleted') !== '1')
				.filter((obj) => {
					if (!tag) {
						return true;
					}
					const noteTags = safeJsonParse(getAttr(obj, 'tags'));
					return noteTags.includes(tag);
				})
				.map((obj) => {
					const rawContent = getAttr(obj, 'content');
					const content = typeof rawContent === 'string' ? rawContent : '';
					return {
						id: getAttr(obj, 'simperiumkey'),
						title: extractTitle(content),
						tags: safeJsonParse(getAttr(obj, 'tags')),
						pinned: getAttr(obj, 'pinned') === '1',
						modified: convertDate(getAttr(obj, 'modificationdate')),
					};
				})
				.sort((a, b) => {
					// Pinned notes first, then by modification date
					if (a.pinned !== b.pinned) {
						return b.pinned - a.pinned;
					}
					return new Date(b.modified) - new Date(a.modified);
				})
				.slice(0, limit);

			return {
				content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
			};
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	}
);

// Tool: search_notes
server.tool(
	'search_notes',
	'Search notes by content, title, or tags',
	{
		query: z.string().describe('Search term'),
		limit: z.number().optional().default(10).describe('Max results'),
		include_deleted: z.boolean().optional().default(false).describe('Include deleted notes'),
	},
	async ({ query, limit, include_deleted }) => {
		try {
			const { notes } = loadStore();
			const q = query.toLowerCase();

			const result = notes
				.filter((obj) => {
					if (!include_deleted && getAttr(obj, 'deleted') === '1') {
						return false;
					}
					return true;
				})
				.filter((obj) => {
					const rawContent = getAttr(obj, 'content');
					const content = typeof rawContent === 'string' ? rawContent.toLowerCase() : '';
					const title = extractTitle(rawContent).toLowerCase();
					const noteTags = safeJsonParse(getAttr(obj, 'tags'));
					const tagsStr = noteTags.join(' ').toLowerCase();

					return (
						content.includes(q) || title.includes(q) || tagsStr.includes(q)
					);
				})
				.map((obj) => {
					const rawContent = getAttr(obj, 'content');
					const content = typeof rawContent === 'string' ? rawContent : '';
					const contentLower = content.toLowerCase();
					const pos = contentLower.indexOf(q);

					let snippet = '';
					if (pos >= 0) {
						const start = Math.max(0, pos - 40);
						const end = Math.min(content.length, pos + q.length + 60);
						snippet =
							(start > 0 ? '...' : '') +
							content.slice(start, end).trim() +
							(end < content.length ? '...' : '');
					} else {
						// Match was in tags, show beginning of content
						snippet = content.slice(0, 100).trim() + (content.length > 100 ? '...' : '');
					}

					return {
						id: getAttr(obj, 'simperiumkey'),
						title: extractTitle(content),
						tags: safeJsonParse(getAttr(obj, 'tags')),
						snippet,
						modified: convertDate(getAttr(obj, 'modificationdate')),
						deleted: getAttr(obj, 'deleted') === '1',
					};
				})
				.sort((a, b) => new Date(b.modified) - new Date(a.modified))
				.slice(0, limit);

			return {
				content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
			};
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	}
);

// Tool: get_note
server.tool(
	'get_note',
	'Get full content of a specific note',
	{
		id: z.string().describe('Note ID (simperiumkey)'),
		include_deleted: z.boolean().optional().default(false).describe('Allow retrieving deleted notes'),
	},
	async ({ id, include_deleted }) => {
		try {
			const { notes } = loadStore();
			const note = notes.find((obj) => getAttr(obj, 'simperiumkey') === id);

			if (!note) {
				return {
					content: [{ type: 'text', text: 'Note not found' }],
					isError: true,
				};
			}

			const isDeleted = getAttr(note, 'deleted') === '1';
			if (isDeleted && !include_deleted) {
				return {
					content: [
						{
							type: 'text',
							text: 'Note is deleted. Use include_deleted: true to retrieve it.',
						},
					],
					isError: true,
				};
			}

			const result = {
				id,
				content: getAttr(note, 'content'),
				tags: safeJsonParse(getAttr(note, 'tags')),
				pinned: getAttr(note, 'pinned') === '1',
				markdown: getAttr(note, 'markdown') === '1',
				deleted: isDeleted,
				created: convertDate(getAttr(note, 'creationdate')),
				modified: convertDate(getAttr(note, 'modificationdate')),
			};

			return {
				content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
			};
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	}
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
