import { brokerCommand, brokerTarget } from "@repo/project-protocol/credential-broker";
import {
	connectorAccess,
	installRequest,
	localManagementRequest,
} from "@repo/project-protocol/portable-connectors";
import { setupNotificationOwner } from "@repo/project-protocol/setup-notifications";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const clientId = z.string().uuid();
const empty = z.object({}).strict();
const path = z.string().min(1).max(4096);
const origin = z
	.string()
	.url()
	.refine((value) => {
		const u = new URL(value);
		return (
			!u.username &&
			!u.password &&
			!u.search &&
			!u.hash &&
			u.pathname === "/" &&
			(u.protocol === "https:" ||
				(u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname)))
		);
	});
export const helperInputs = {
	"updates.activity": empty,
	"updates.deviceActivity": z.object({ busy: z.boolean() }).strict(),
	"updates.retain": empty,
	"updates.connectors": empty,
	"updates.cancelConnector": z.object({ id: id.optional() }).strict(),
	"updates.checkConnectors": empty,
	"updates.pin": z.object({ id, pinned: z.boolean() }).strict(),
	"updates.applyConnector": z.object({ id, automatic: z.boolean().default(false) }).strict(),
	"updates.enroll": z.object({ id }).strict(),
	"updates.prepareConnectors": empty,
	"updates.automaticConnectors": empty,
	"updates.acquire": empty,
	"updates.release": empty,
	"broker.authorizeAssistant": z.object({ principalId: z.string() }).strict(),
	"broker.enabled": empty,
	"broker.stage": z
		.object({
			clientId,
			sessionId: z.string().uuid(),
			targets: z.array(brokerTarget).min(1).max(50),
		})
		.strict(),
	"credentials.chromeStatus": empty,
	"credentials.chromeCheck": empty,
	"broker.list": empty,
	"broker.call": z
		.object({ principalId: z.string(), requestId: z.string().uuid(), command: brokerCommand })
		.strict(),
	"browser.list": empty,
	"browser.resumeRecovery": empty,
	"browser.review": z.object({ requestId: z.string().uuid() }).strict(),
	"browser.approve": z
		.object({ requestId: z.string().uuid(), capability: z.string().min(40).max(100) })
		.strict(),
	"browser.cancel": z.object({ requestId: z.string().uuid() }).strict(),
	"browser.focus": z
		.object({ requestId: z.string().uuid(), profileId: z.string().uuid() })
		.strict(),
	"portable.install": installRequest,
	"portable.manage": localManagementRequest,
	"portable.status": z.object({ id: z.string().uuid().optional() }).strict(),
	"portable.fields": z.object({ id }).strict(),
	"portable.devices": empty,
	"portable.copy": z
		.object({ sourceId: z.string().uuid(), idempotencyKey: z.string().min(1).max(200) })
		.strict(),
	"server.access": z.object({ id, access: connectorAccess }).strict(),
	"credentials.status": empty,
	"credentials.configure": z.object({ settings: z.unknown() }).strict(),
	"credentials.save": z.object({ settings: z.unknown() }).strict(),
	"credentials.prepare": z.object({ server: z.string().url().max(4096) }).strict(),
	"credentials.signIn": z
		.object({
			email: z.string().email().max(254),
			password: z.string().min(1).max(4096),
			clientId: z.string().max(200).optional(),
			clientSecret: z.string().max(4096).optional(),
			method: z.enum(["0", "1", "3"]).optional(),
		})
		.strict(),
	"credentials.answer": z
		.object({
			value: z
				.string()
				.min(1)
				.max(4096)
				.refine((v) => !v.split("").some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)),
		})
		.strict(),
	"credentials.cancel": empty,
	"credentials.disconnect": empty,
	"credentials.browsers": empty,
	"credentials.browserSelect": z
		.object({ id: z.string().regex(/^[a-f0-9]{24}$/), launch: z.boolean() })
		.strict(),
	"credentials.browserClose": empty,
	"credentials.unlock": z.object({ password: z.string().min(1).max(4096) }).strict(),
	"credentials.lock": empty,
	"credentials.items": empty,
	"credentials.approve": z
		.object({
			principalId: z.string().min(1).max(200),
			id: z.string().uuid(),
			allow: z.boolean(),
			remember: z.boolean().default(false),
		})
		.strict(),
	status: empty,
	"server.add": z.object({ config: z.unknown() }).strict(),
	"server.preview": z.object({ id: id.optional(), config: z.unknown() }).strict(),
	"server.update": z.object({ id, config: z.unknown() }).strict(),
	"server.remove": z.object({ id }).strict(),
	"server.start": z.object({ id }).strict(),
	"server.stop": z.object({ id }).strict(),
	"server.restart": z.object({ id }).strict(),
	"server.permissions": z.object({ id, tools: z.array(z.string()).max(300) }).strict(),
	"server.link": z.object({ id, linked: z.boolean() }).strict(),
	"import.preview": z.object({ file: path }).strict(),
	"import.apply": z
		.object({
			file: path,
			selected: z.array(id).min(1).max(50),
			fingerprint: z.string().optional(),
		})
		.strict(),
	"migration.preview": z.object({ root: path.optional() }).strict(),
	"migration.apply": z
		.object({ root: path.optional(), selected: z.array(id).min(1).max(50) })
		.strict(),
	"catalog.list": empty,
	"catalog.install": z
		.object({
			catalogId: id,
			configuration: z.record(z.string(), z.string()).default({}),
			idempotencyKey: z.string().min(1).max(200).optional(),
		})
		.strict(),
	"catalog.authenticate": z.object({ id }).strict(),
	"catalog.verify": z.object({ id }).strict(),
	"catalog.notificationsDelivered": z
		.object({ owner: setupNotificationOwner, ids: z.array(z.string().uuid()).min(1).max(50) })
		.strict(),
	"catalog.cancel": z.object({ jobId: z.string().min(1) }).strict(),
	"client.list": empty,
	"client.register": z.object({ name: z.string().trim().min(1).max(80) }).strict(),
	"client.revoke": z.object({ clientId }).strict(),
	"client.permissions": z
		.object({ clientId, tools: z.array(z.string().max(128)).max(15000).nullable() })
		.strict(),
	"client.preview-install": z
		.object({
			clientId,
			client: z.enum(["codex", "claude-code", "claude-desktop", "other"]),
			configPath: path.optional(),
		})
		.strict(),
	"client.install": z
		.object({
			clientId,
			client: z.enum(["codex", "claude-code", "claude-desktop"]),
			configPath: path.optional(),
			replace: z.boolean().default(false),
			removeLegacy: z.array(z.enum(["laplace", "laplace-local"])).optional(),
			fingerprint: z.string().optional(),
		})
		.strict(),
	"hosted.connect": z.object({ clientId, desktopManagement: z.boolean().optional() }).strict(),
	"hosted.disconnect": z.object({ clientId }).strict(),
	"link.prepare": z.object({ origin }).strict(),
	"link.start": z
		.object({ origin: origin.optional(), name: z.string().trim().min(1).max(80).optional() })
		.strict(),
	"link.poll": empty,
	"link.complete": z
		.object({ origin, installationId: z.string().uuid(), accountId: z.string().min(1) })
		.strict(),
	"link.unlink": empty,
	"link.block": empty,
	shutdown: empty,
} as const;
export type HelperMethod = keyof typeof helperInputs;
export const privateHelperMethods = new Set<HelperMethod>([
	"updates.retain",
	"updates.activity",
	"updates.deviceActivity",
	"updates.acquire",
	"updates.release",
	"updates.prepareConnectors",
	"updates.automaticConnectors",
	"catalog.notificationsDelivered",
	"link.prepare",
	"link.complete",
	"link.block",
	"shutdown",
]);
export const helperRequest = z
	.object({
		id: z.string().min(1).max(100),
		method: z.enum(Object.keys(helperInputs) as [HelperMethod, ...HelperMethod[]]),
		input: z.unknown().default({}),
	})
	.strict();
export type HelperRequest = z.infer<typeof helperRequest>;
export type HelperReply = { id: string; result: unknown } | { id: string; error: string };
export type ServerSnapshot = {
	access?: { visible: boolean; remoteEnabled: boolean };
	id: string;
	name: string;
	transport: "stdio" | "http";
	enabled: boolean;
	status: "stopped" | "starting" | "online" | "paused" | "needs_attention";
	command?: string;
	args?: string[];
	argumentCount?: number;
	cwd?: string;
	url?: string;
	secretKeys: string[];
	linkMode: "local-only" | "linked" | "blocked";
	cloudEnabled?: boolean;
	tools: Array<{
		name: string;
		description?: string;
		localEnabled: boolean;
		enabled: boolean;
		inputSchema: Record<string, unknown>;
	}>;
	diagnostic: string[];
	installedVersion?: string;
};
export type ClientSnapshot = {
	id: string;
	name: string;
	enabled: boolean;
	createdAt: string;
	allowedLocalTools?: string[];
	hosted: "disconnected" | "connecting" | "connected" | "needs-auth";
	error?: string;
};
export type DesktopSnapshot = {
	mcp?: {
		activeCalls: number;
		activeRequests: number;
		subscriptions: number;
		protocols: string[];
		events: Array<{ at: string; reason: string }>;
	};
	credentialRequests?: number;
	mode: "local-only" | "linking" | "linked" | "linked-blocked";
	origin: string;
	error?: string;
	accountId?: string;
	installationId?: string;
	servers: ServerSnapshot[];
	clients: ClientSnapshot[];
	localTools: Array<{ name: string; title: string }>;
	jobs: unknown[];
	endpoint?: string;
	runId: string;
	stayLocalOnly: boolean;
};
export type HelperEvent =
	| { event: "desktop-open"; section: "servers" | "clients" | "device" | "updates" | "credentials" }
	| { event: "broker-focus" }
	| { event: "broker-unlock"; sessionId: string }
	| { event: "browser-approval"; requestId: string }
	| { event: "ready" }
	| { event: "snapshot"; data: DesktopSnapshot }
	| { event: "open-url"; url: string };
