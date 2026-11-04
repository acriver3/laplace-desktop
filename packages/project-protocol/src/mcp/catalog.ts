/** Transport is one policy input; it does not imply where a tool executes. */
export interface CatalogContext {
	transport: "http" | "stdio";
	connection: "hosted" | "desktop" | "local";
	scopes?: readonly string[];
	features?: readonly string[];
}

export interface ToolRequirements {
	transports?: readonly CatalogContext["transport"][];
	connections?: readonly CatalogContext["connection"][];
	scopes?: readonly string[];
	features?: readonly string[];
}

export interface ToolDescriptor {
	name: string;
}

export interface ToolRoute {
	executor: string;
	target: string;
}

export interface CatalogEntry<T extends ToolDescriptor = ToolDescriptor> {
	id: string;
	tool: T;
	route: ToolRoute;
	requirements?: ToolRequirements;
	available?: boolean;
}

export function toolAllowed(context: CatalogContext, entry: CatalogEntry): boolean {
	const required = entry.requirements;
	return (
		entry.available !== false &&
		(!required?.transports || required.transports.includes(context.transport)) &&
		(!required?.connections || required.connections.includes(context.connection)) &&
		(!required?.scopes || required.scopes.every((scope) => context.scopes?.includes(scope))) &&
		(!required?.features ||
			required.features.every((feature) => context.features?.includes(feature)))
	);
}

export class ToolUnavailableError extends Error {
	constructor() {
		super("Unknown tool or tool unavailable; refresh the catalog.");
		this.name = "ToolUnavailableError";
	}
}

export type ToolExecutor<R> = (
	route: ToolRoute,
	input: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<R>;

/** Build per request from current facts. Executors must still reauthorize at execution. */
export class ToolCatalog<T extends ToolDescriptor> {
	private readonly entries = new Map<string, CatalogEntry<T>>();
	constructor(context: CatalogContext, entries: readonly CatalogEntry<T>[]) {
		const ids = new Set<string>();
		const names = new Set<string>();
		for (const entry of entries) {
			// A disabled candidate still owns its name: permission changes must not
			// silently reroute an old tool call to a different executor.
			if (names.has(entry.tool.name) || ids.has(entry.id))
				throw new Error("Conflicting tool catalog entries");
			ids.add(entry.id);
			names.add(entry.tool.name);
			if (!toolAllowed(context, entry)) continue;
			this.entries.set(entry.tool.name, entry);
		}
	}
	tools(): T[] {
		return [...this.entries.values()].map((entry) => entry.tool);
	}
	resolve(name: string): CatalogEntry<T> {
		const entry = this.entries.get(name);
		if (!entry) throw new ToolUnavailableError();
		return entry;
	}
	async dispatch<R>(
		name: string,
		input: Record<string, unknown>,
		executors: Readonly<Record<string, ToolExecutor<R>>>,
		signal?: AbortSignal,
	): Promise<R> {
		signal?.throwIfAborted();
		const entry = this.resolve(name);
		const execute = Object.prototype.hasOwnProperty.call(executors, entry.route.executor)
			? executors[entry.route.executor]
			: undefined;
		if (!execute) throw new ToolUnavailableError();
		return execute(entry.route, input, signal);
	}
}
