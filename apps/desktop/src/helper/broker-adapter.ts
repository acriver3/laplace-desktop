import {
	type BrokerItem,
	type BrokerSession,
	type CredentialCandidate,
} from "@repo/project-protocol/credential-broker";
import { z } from "zod";

import { credentialBrokeringEnabled } from "../shared/credential-broker-feature";
import { BrokerBrowser } from "./broker-browser";
import type { CatalogInstaller } from "./catalog";
import type { ConnectionBrokerAdapter, BrokerExecution } from "./connection-broker";
import type { CredentialBroker, CredentialPrincipal } from "./credentials";
import { browserTargets } from "./credentials-cdp";
import type { DesktopManager } from "./manager";
import type { PortableConnectors } from "./portable";
export function desktopBrokerAdapter(
	manager: DesktopManager,
	credentials: CredentialBroker,
	catalog: CatalogInstaller,
	portable: PortableConnectors,
	focus: (section?: "servers" | "device" | "clients" | "credentials") => void,
	unlock?: (sessionId: string) => void,
	prepareHosted?: (principal: CredentialPrincipal, session: BrokerSession) => Promise<void>,
): ConnectionBrokerAdapter {
	const preparations = new Map<string, boolean>();
	const localBrowser = new BrokerBrowser(() => credentials.snapshot().settings.cdpEndpoint);
	const managedBrowser = credentials.brokerChrome;
	async function authorize(principal: CredentialPrincipal) {
		if (!credentialBrokeringEnabled()) throw Error("Credential brokering is disabled.");
		await principal.authorize();
	}
	async function gateway(session: BrokerSession, action: string, item?: BrokerItem) {
		return (await manager.credentialRelayApi()).post("broker", {
			sessionId: session.id,
			action,
			itemId: item?.target.id,
			matches: item?.matches ?? [],
		});
	}
	async function validate(
		principal: CredentialPrincipal,
		session: BrokerSession,
		item: BrokerItem,
	) {
		await authorize(principal);
		if (!principal.hosted) {
			const id = principal.id.replace(/^local:/, "");
			if (!manager.clientToolAllowed(id, "local_connectors_manage"))
				throw Error("Enable connector management for this assistant.");
		}
		if (item.target.location === "local" && ["browser", "oauth2"].includes(item.target.authType))
			throw Error(
				"This local connector requires manual authentication. Chrome brokering is not supported by this connector yet.",
			);
		if (
			item.matches.some((m) => m.source.kind === "bitwarden") &&
			!credentials.brokerAllowed(principal)
		)
			throw Error("Authorize this assistant for credential matching in Desktop.");
		if (manager.status().mode === "linked") {
			const details = (await gateway(session, "describe")) as { targets: BrokerItem["target"][] };
			const target = details.targets.find((t) => t.id === item.target.id);
			if (!target || JSON.stringify(target) !== JSON.stringify(item.target))
				throw Error("Reviewed destination changed.");
		}
		const login = item.matches.filter((m) => m.source.kind === "bitwarden");
		if (item.target.authType === "oauth2" || item.target.authType === "browser") {
			if (
				!(item.target.authType === "oauth2" && !item.matches.length) &&
				(login.length !== 1 || item.matches.length !== 1 || login[0]!.field !== "login")
			)
				throw Error("Choose one login.");
			const source = login[0]?.source;
			if (
				source &&
				(source.kind !== "bitwarden" ||
					!(await credentials.brokerCandidates(principal)).some(
						(c) => c.id === source.credentialId,
					))
			)
				throw Error("Login unavailable.");
		} else if (item.matches.some((m) => m.source.kind !== "doppler"))
			throw Error("API credentials require Doppler references.");
		if (item.target.location === "cloud" || item.matches.some((m) => m.source.kind === "doppler"))
			await gateway(session, "validate", item);
		if (item.target.location === "local") {
			if (
				item.target.connectionId &&
				!(await catalog.brokerReauthenticationSupported(item.target.connectionId))
			)
				throw Error(
					"This connector cannot verify an unchanged account. Use manual reauthentication.",
				);
			if (item.matches.some((m) => ["workspace", "canvas_url"].includes(m.field)))
				throw Error("Configure non-credential destination settings manually before matching.");
			const fields = item.target.connectionId
				? await portable.fields(item.target.connectionId)
				: (await catalog.list()).find((e) => e.id === item.target.catalogId)?.fields;
			if (!fields) throw Error("Choose a catalog connector.");
			if (
				item.target.authType !== "browser" &&
				item.target.authType !== "oauth2" &&
				(fields.some(
					(f) => f.required && !f.default && !item.matches.some((m) => m.field === f.key),
				) ||
					item.matches.some((m) => !fields.some((f) => f.key === m.field)))
			)
				throw Error("Map the required catalog fields.");
		}
	}
	function receipt(value: unknown): BrokerExecution {
		const r = z
			.object({
				status: z.string().optional(),
				requestId: z.string().optional(),
				state: z.string().optional(),
			})
			.passthrough()
			.parse(value);
		return {
			state:
				r.status === "connected"
					? "connected"
					: r.status === "failed" || r.status === "expired"
						? "failed"
						: "user_action_required",
			message:
				r.status === "connected"
					? "Connected and verified."
					: "Continue login or complete the challenge, then verify.",
			operationId: r.requestId,
			connectorId: z.object({ connection: z.object({ id: z.string() }).optional() }).parse(r)
				.connection?.id,
		};
	}
	return {
		authorize,
		scope: () => ({
			accountId: manager.status().accountId,
			installationId: manager.status().installationId,
		}),
		epoch: () => credentials.brokerEpoch,
		automatic: true,
		async prepare(principal, session) {
			if (
				!prepareHosted ||
				principal.hosted ||
				manager.status().mode !== "linked" ||
				preparations.get(session.id) === true ||
				session.expiresAt <= Date.now()
			)
				return;
			if (
				!manager.clientToolAllowed(principal.id.replace(/^local:/, ""), "local_connectors_manage")
			)
				return;
			try {
				await prepareHosted(principal, session);
				preparations.set(session.id, true);
			} catch {
				preparations.set(session.id, false);
			}
		},
		unlock,
		readiness(principal, session) {
			if (
				!principal.hosted &&
				(!manager.clientToolAllowed(
					principal.id.replace(/^local:/, ""),
					"local_connectors_manage",
				) ||
					preparations.get(session.id) === false)
			)
				return {
					code: "authorize_management",
					message:
						"Connect this assistant to Laplace and authorize Desktop management in AI clients. This request will resume when access is ready.",
					action: "desktop",
				};
			if (
				session.items.some((i) => i.target.location === "cloud") &&
				manager.status().mode !== "linked"
			)
				return {
					code: "link_account",
					message: "Link this Desktop to the destination Laplace account.",
					action: "desktop",
				};
			if (
				session.items.some(
					(i) =>
						i.target.location === "local" &&
						["browser", "oauth2"].includes(i.target.authType) &&
						!["connected", "cancelled", "expired"].includes(i.state),
				)
			)
				return {
					code: "manual_setup",
					message:
						"This local connector does not yet support sign-in through the Chrome extension. Use its manual setup on this device.",
					action: "desktop",
				};
			const needsVault = session.items.some(
				(i) =>
					!["connected", "cancelled", "expired"].includes(i.state) &&
					(i.matches.some((m) => m.source.kind === "bitwarden") ||
						i.target.authType === "browser" ||
						(i.target.authType === "oauth2" &&
							(i.credentialRequested || (i.attempted && i.state === "matching")))),
			);
			if (needsVault) {
				if (!credentials.snapshot().settings.enabled)
					return {
						code: "connect_vault",
						message: "Connect Bitwarden in Credentials to choose a saved login.",
						action: "desktop",
					};
				if (!credentials.brokerAllowed(principal))
					return {
						code: "authorize_assistant",
						message: "Enable this assistant in Credentials → Assistant access.",
						action: "desktop",
					};
				if (!credentials.snapshot().unlocked)
					return {
						code: "unlock_vault",
						message: "Unlock Bitwarden to continue this request.",
						action: "unlock",
					};
			}
			if (
				session.items.some(
					(i) => i.state === "matching" && !(i.target.authType === "oauth2" && !i.attempted),
				)
			)
				return {
					code: "choose_credential",
					message: "Choose a saved credential for the connection.",
					action: "choose",
				};
			if (
				session.items.some(
					(i) =>
						i.target.location === "cloud" &&
						i.browserTargetId &&
						["running", "user_action_required", "verifying"].includes(i.state) &&
						managedBrowser.isReady?.(i.browserTargetId) === false,
				)
			)
				return {
					code: "enable_chrome",
					message:
						"Finish connecting the Laplace extension in your regular Chrome profile. This sign-in request stays open.",
					action: "desktop",
				};
			return { code: "ready", message: "Ready to continue." };
		},
		focus,
		cancel: async (session) => {
			for (const item of session.items)
				if (item.browserTargetId && item.target.location === "cloud")
					managedBrowser.cancel(item.browserTargetId);
			if (manager.status().mode === "linked") await gateway(session, "cancel");
		},
		validate,
		async candidates(principal, session) {
			await authorize(principal);

			const result: CredentialCandidate[] = [];
			if (credentials.brokerAllowed(principal) && credentials.snapshot().unlocked)
				for (const item of await credentials.brokerCandidates(principal))
					result.push({
						source: { kind: "bitwarden", credentialId: item.id },
						label: item.label,
						origins: item.origins,
					});
			if (manager.status().mode === "linked") {
				const cloud = (await gateway(session, "candidates")) as {
					candidates: CredentialCandidate[];
				};
				result.push(...cloud.candidates);
			}
			return result;
		},
		async execute(principal, session, item, signal) {
			await authorize(principal);
			if (item.target.location === "cloud") {
				const needsBrowser = item.target.authType === "oauth2";
				if (needsBrowser) {
					signal.throwIfAborted();
					await validate(principal, session, item);
				}
				const result = (await gateway(session, "execute", item)) as { authorizationUrl?: string };
				const out = receipt(result);
				if (result.authorizationUrl) {
					try {
						await authorize(principal);
						signal.throwIfAborted();
						out.browserTargetId = await managedBrowser.open(
							result.authorizationUrl,
							item.matches.length ? item.matches.flatMap((m) => m.origins ?? []) : [],
							signal,
						);
						out.message =
							"Sign-in opened in your existing Chrome session. Complete any extension permission or provider challenge; Laplace will continue automatically.";
					} catch {
						out.message =
							"Setup is staged, but the sign-in tab could not open. Continue through the setup request manually; do not repeat the connection request.";
						focus();
					}
				}
				return out;
			}
			let id = item.target.connectionId;
			let configuration: Record<string, string> = {};
			if (item.matches.some((m) => m.source.kind === "doppler")) {
				const response = await gateway(session, "redeem", item);
				configuration = z
					.object({ values: z.record(z.string(), z.string()) })
					.parse(response).values;
			}
			await validate(principal, session, item);
			const check = () => {
				signal.throwIfAborted();
				if (!credentials.brokerAllowed(principal)) throw Error("Access revoked.");
			};
			if (id) {
				if (Object.keys(configuration).length)
					await portable.manage({ action: "configure", id, configuration }, check);
			} else {
				const installed = await portable.install(
					{
						catalogId: item.target.catalogId,
						configuration,
						idempotencyKey: session.id + ":" + item.target.id,
					},
					check,
				);
				id = installed.connectorId;
				const deadline = Date.now() + 300000;
				for (;;) {
					check();
					const op = (await portable.status(installed.id))[0];
					if (
						!op ||
						["failed", "cancelled", "interrupted", "needs_configuration"].includes(op.status)
					)
						throw Error("Finish local setup in Desktop.");
					if (op.status !== "running") break;
					if (Date.now() > deadline)
						throw Error("Inspect the local installation before continuing.");
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
			await authorize(principal);
			check();
			const op = (await portable.manage(
				{
					action:
						item.target.authType === "browser" || item.target.authType === "oauth2"
							? "authenticate"
							: "verify",
					id,
				},
				check,
			)) as { id?: string };
			const out: BrokerExecution = {
				state: "user_action_required",
				message: "Setup started. Check sign-in and verify.",
				operationId: op.id,
				connectorId: id,
			};
			if (item.matches[0]?.source.kind === "bitwarden") {
				const login = (await credentials.brokerCandidates(principal)).find(
					(c) => c.id === (item.matches[0]!.source as { credentialId: string }).credentialId,
				);
				const tabs = (
					await browserTargets(credentials.snapshot().settings.cdpEndpoint, signal).catch(() => [])
				).filter((t) => login?.origins.includes(t.origin));
				if (tabs.length === 1) out.browserTargetId = tabs[0]!.id;
			}
			return out;
		},
		async browser(principal, session, item, command, signal) {
			const browser = item.target.location === "cloud" ? managedBrowser : localBrowser;
			await authorize(principal);
			if (command.operation === "verify") {
				if (item.target.location === "cloud")
					return receipt(await gateway(session, "status", item));
				const op = catalog.jobs().find((r) => r.id === item.operationId);
				if (op?.status === "completed")
					return { state: "connected", message: "Connected and verified." };
				if (op?.status === "running")
					return {
						state: "user_action_required",
						message: "Connector verification is still running.",
					};
				const id = item.connectorId ?? item.target.connectionId;
				if (!id)
					return {
						state: "failed",
						message: "Inspect installation in Desktop before creating another attempt.",
					};
				const check = () => {
					signal.throwIfAborted();
					if (!credentials.allowed(principal)) throw Error("Access revoked.");
				};
				const verified = (await portable.manage({ action: "verify", id }, check)) as {
					id?: string;
				};
				return {
					state: "user_action_required",
					operationId: verified.id,
					message: "Checking the connector's authenticated verification.",
				};
			}
			if (!item.browserTargetId && item.target.location === "local") {
				const source = item.matches.find((m) => m.source.kind === "bitwarden")?.source;
				if (source?.kind === "bitwarden") {
					const login = (await credentials.brokerCandidates(principal)).find(
						(c) => c.id === source.credentialId,
					);
					const tabs = (
						await browserTargets(credentials.snapshot().settings.cdpEndpoint, signal)
					).filter((t) => login?.origins.includes(t.origin));
					if (tabs.length === 1) item.browserTargetId = tabs[0]!.id;
				}
			}
			if (!item.browserTargetId) {
				focus();
				return {
					state: "user_action_required",
					message: "Open the login in the configured Desktop browser.",
				};
			}
			if (command.operation === "focus") {
				await browser.focus(item.browserTargetId, signal);
				return {
					state: "user_action_required",
					message: "Complete the browser challenge, then verify.",
				};
			}
			if (item.target.location === "cloud" && item.matches.length)
				managedBrowser.allowOrigins(
					item.browserTargetId,
					item.matches.flatMap((m) => m.origins ?? []),
				);
			const observation = await browser.inspect(item.browserTargetId, signal);
			if (command.operation === "inspect" || observation.handoff)
				return {
					state: "user_action_required",
					observation,
					message: observation.handoff
						? observation.handoffReason === "permission_required"
							? item.matches.length
								? "Allow the requested sign-in site access in the Laplace extension tab in Chrome."
								: "Continue in Chrome. If a login is needed, choose a saved credential here."
							: "Complete the login challenge or provider consent in Chrome."
						: "Login fields are ready.",
				};
			const match = item.matches.find((m) => m.source.kind === "bitwarden");
			if (
				match?.source.kind !== "bitwarden" ||
				!command.pageRevision ||
				!match.origins?.includes(observation.origin)
			)
				throw Error("Login match or page review unavailable.");
			await credentials.withBrokerLogin(
				principal,
				match.source.credentialId,
				observation.origin,
				(values) => browser.advance(item.browserTargetId!, command.pageRevision!, values, signal),
			);
			return {
				state: "user_action_required",
				message: "Sign-in submitted. Checking the next step and verifying the connection.",
			};
		},
	};
}
