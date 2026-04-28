export interface ServerArgs {
	explicitPath?: string;
}

export function parseServerArgs(args: string[]): ServerArgs {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (typeof arg !== 'string') continue;
		if (arg.startsWith('--path=')) {
			const value = arg.slice('--path='.length);
			if (!value) {
				throw new Error('--path= requires a value');
			}
			return { explicitPath: value };
		}
		if (arg === '--path') {
			const value = args[i + 1];
			if (!value || value.startsWith('--')) {
				throw new Error('--path requires a value');
			}
			return { explicitPath: value };
		}
	}
	return {};
}
