export interface CatalogEntry {
	setupUrl?: string;
	browserMode?: "tethered" | "background-browser";
	id: string;
	name: string;
	description: string;
	version?: string;
	serverId?: string;
	available: boolean;
	demoOnly?: boolean;
	installed?: boolean;
	installedVersion?: string;
	installedBrowserMode?: "tethered" | "background-browser";
	importOnly?: boolean;
	capabilities?: string[];
	authentication?: string[];
	fields: Array<{
		key: string;
		label: string;
		type: string;
		required?: boolean;
		default: string;
		options?: string[];
	}>;
}
export interface CatalogJob {
	connectorName?: string;
	notificationDelivered?: boolean;
	id: string;
	serverId: string;
	catalogId: string;
	status: string;
	kind: string;
	stage: string;
	message: string;
	progress?: number;
	error?: string;
}
export interface ImportPreview {
	source: string;
	fingerprint?: string;
	notice?: string;
	entries: Array<{
		id: string;
		name: string;
		error?: string;
		command?: string;
		args?: string[];
		argumentCount?: number;
		resolvedCommand?: string;
		resolvedArgs?: string[];
		resolvedDirectory?: string;
		cwd?: string;
		url?: string;
		secretKeys?: string[];
		enabled?: boolean;
	}>;
}
export interface RegistrationPreview {
	client: string;
	clientId: string;
	file: string;
	conflict: boolean;
	entryName: string;
	entry: { command: string; args: string[] };
	fingerprint: string;
	legacyEntries: Array<"laplace" | "laplace-local">;
	instructions: string;
}
export const invoke = <T = unknown>(method: string, input?: unknown) =>
	window.laplaceDesktop.invoke<T>(method, input);
export type Perform = (work: () => Promise<unknown>, success?: string) => Promise<void>;
