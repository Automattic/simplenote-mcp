export interface ServerArgs {
	explicitPath?: string;
	mode?: 'help' | 'version';
}

export function parseServerArgs(args: string[]): ServerArgs {
	let explicitPath: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (typeof arg !== 'string') continue;
		if (arg === '--help' || arg === '-h') {
			return { mode: 'help' };
		}
		if (arg === '--version' || arg === '-V') {
			return { mode: 'version' };
		}
		if (arg.startsWith('--path=')) {
			const value = arg.slice('--path='.length);
			if (!value) {
				throw new Error('--path= requires a value');
			}
			if (explicitPath !== undefined) {
				throw new Error('--path specified more than once');
			}
			explicitPath = value;
			continue;
		}
		if (arg === '--path') {
			const value = args[i + 1];
			if (!value || value.startsWith('--')) {
				throw new Error('--path requires a value');
			}
			if (explicitPath !== undefined) {
				throw new Error('--path specified more than once');
			}
			explicitPath = value;
			i++;
			continue;
		}
		if (arg.startsWith('--')) {
			throw new Error(`Unknown flag: ${arg}. Run with --help for usage.`);
		}
		throw new Error(`Unexpected argument: ${arg}. Run with --help for usage.`);
	}
	return explicitPath !== undefined ? { explicitPath } : {};
}
