import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { minimalEnvironment } from "@repo/local-mcp-core/config";
import { spawnLocal, stopTree } from "@repo/local-mcp-core/process";

import type { BitwardenConnection, SignInChallenge } from "./shared/credential-setup";
import { bitwardenError, CredentialSetupError } from "./credential-errors";
import { bitwardenCommand } from "./credentials-execution";

export const BITWARDEN_VERSION = "2026.10.0";
const BITWARDEN_INTEGRITY =
	"sha512-aDl9FXaiVWdrWpAjCA6aZHOuJVwqrjwYjVM3AlIzfec0i209/3puNoHglGUIZnyCs/j3LdcvO7024RckPcXXsA==";
// Strip terminal ANSI sequences only; the remaining text is kept private.
// oxlint-disable-next-line no-control-regex
const strip = (v: string) => v.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
/** Only recognized prompts can cross into the renderer. Raw CLI text stays private. */
export function loginPrompt(
	text: string,
): { challenge: SignInChallenge; methods?: string[] } | undefined {
	const value = strip(text);
	const line =
		value
			.split(/[\r\n]/)
			.filter((v) => /Two-step login|New device verification|client_secret:/.test(v))
			.at(-1) ?? "";
	if (/New device verification required.*login email:\s*$/i.test(line))
		return { challenge: "device_code" };
	if (/Two-step login code:\s*$/i.test(line)) return { challenge: "code" };
	if (/client_secret:\s*$/i.test(line)) return { challenge: "api_secret" };
	if (/Two-step login method:\s*(?:\(Use arrow keys\))?\s*$/i.test(line)) {
		const methods = value
			.split("\n")
			.map((line) => line.trim().replace(/^[❯>]\s*/, ""))
			.filter((line) =>
				/^(Authenticator(?: App)?|Email|YubiKey(?: OTP)?|Yubico OTP Security Key)$/i.test(line),
			);
		if (methods.length) return { challenge: "method", methods: [...new Set(methods)] };
	}
	return undefined;
}

export class BitwardenConnectionManager {
	readonly directory: string;
	readonly appData: string;
	private child?: ChildProcessWithoutNullStreams;
	private controller?: AbortController;
	private generation = 0;
	private authenticating = false;
	private timer?: ReturnType<typeof setTimeout>;
	private promptTimer?: ReturnType<typeof setTimeout>;
	private phase: BitwardenConnection["phase"] = "disconnected";
	private account?: string;
	private error?: BitwardenConnection["error"];
	private challenge?: SignInChallenge;
	private methods?: string[];
	private promptSeen = false;
	private stdout = "";
	private stderr = "";
	private managed = false;
	private server = "https://vault.bitwarden.com";
	constructor(
		private root: string,
		private resources: string,
		private changed: () => void,
	) {
		this.directory = join(root, "components", `bitwarden-${BITWARDEN_VERSION}`);
		this.appData = join(root, "bitwarden-vault");
	}
	get executable() {
		return join(this.directory, "node_modules", "@bitwarden", "cli", "build", "bw.js");
	}
	snapshot(): BitwardenConnection {
		return {
			mode: this.managed ? "managed" : "legacy",
			phase: this.phase,
			account: this.account,
			server: this.server,
			error: this.error,
			challenge: this.challenge,
			methods: this.methods,
		};
	}
	async initialize(managed: boolean, server: string, legacyPath: string) {
		const generation = this.generation;
		this.managed = managed;
		this.server = server;
		try {
			const raw = managed
				? await this.command(["status"])
				: await bitwardenCommand(legacyPath, ["status"], undefined, AbortSignal.timeout(10000));
			const info = JSON.parse(raw);
			if (generation !== this.generation) return;
			this.account = typeof info.userEmail === "string" ? info.userEmail.slice(0, 254) : undefined;
			this.phase =
				info.status === "unauthenticated" ? (managed ? "ready" : "disconnected") : "connected";
		} catch {
			if (generation === this.generation) {
				this.phase = managed ? "error" : "disconnected";
				if (managed) this.error = "unavailable";
			}
		}
	}
	command(args: string[], session?: string, signal = AbortSignal.timeout(30000), master?: string) {
		return bitwardenCommand(process.execPath, args, session, signal, master, {
			args: [this.executable],
			appData: this.appData,
		});
	}
	/** Installs a complete lockfile, with every tarball pinned by integrity. No lifecycle scripts or global writes. */
	async prepare() {
		if (this.authenticating || this.controller) throw new CredentialSetupError("busy");
		const controller = new AbortController();
		this.controller = controller;
		this.phase = "preparing";
		this.error = undefined;
		this.changed();
		const staging = `${this.directory}.staging`;
		try {
			const lockPath = join(this.resources, "bitwarden", "package-lock.json");
			const lockBytes = await readFile(lockPath);
			const lock = JSON.parse(lockBytes.toString());
			if (lock.packages?.["node_modules/@bitwarden/cli"]?.integrity !== BITWARDEN_INTEGRITY)
				throw new Error("Invalid manifest");
			for (const [name, p] of Object.entries(lock.packages) as Array<
				[string, { resolved?: string; integrity?: string }]
			>) {
				if (
					name &&
					(!p.resolved?.startsWith("https://registry.npmjs.org/") ||
						!p.integrity?.startsWith("sha512-"))
				)
					throw new Error("Invalid dependency source");
			}
			const receipt = createHash("sha256").update(lockBytes).digest("hex");
			let installed = false;
			try {
				installed =
					(await readFile(join(this.directory, "receipt"), "utf8")) === receipt &&
					(await stat(this.executable)).isFile();
			} catch {}
			if (!installed) {
				await rm(staging, { recursive: true, force: true });
				await mkdir(staging, { recursive: true, mode: 0o700 });
				await copyFile(lockPath, join(staging, "package-lock.json"));
				await copyFile(
					join(this.resources, "bitwarden", "package.json"),
					join(staging, "package.json"),
				);
				const env = minimalEnvironment(homedir(), {});
				// Never consume the user's npm credentials/configuration for this public component.
				Object.assign(env, {
					npm_config_userconfig: join(staging, "empty.npmrc"),
					npm_config_globalconfig: join(staging, "empty-global.npmrc"),
					npm_config_cache: join(this.root, "component-cache"),
					npm_config_registry: "https://registry.npmjs.org",
					npm_config_update_notifier: "false",
				});
				await this.runInstall(staging, env, controller.signal);
				controller.signal.throwIfAborted();
				await rm(this.directory, { recursive: true, force: true });
				await rename(staging, this.directory);
				if (
					(await this.command(["--version"], undefined, controller.signal)).trim() !==
					BITWARDEN_VERSION
				)
					throw new Error("Runtime version mismatch");
				const { writeFile } = await import("node:fs/promises");
				await writeFile(join(this.directory, "receipt"), receipt, { mode: 0o600 });
			}
			await mkdir(this.appData, { recursive: true, mode: 0o700 });
			controller.signal.throwIfAborted();
			this.phase = this.account ? "connected" : "ready";
		} catch {
			this.phase = "error";
			this.error = controller.signal.aborted ? "cancelled" : "download";
			throw new CredentialSetupError(this.error);
		} finally {
			await rm(staging, { recursive: true, force: true });
			this.controller = undefined;
			this.changed();
		}
	}
	private runInstall(cwd: string, env: Record<string, string>, signal: AbortSignal) {
		return new Promise<void>((resolve, reject) => {
			const child = spawnLocal(
				process.execPath,
				[
					join(this.resources, "runtimes", "npm", "bin", "npm-cli.js"),
					"ci",
					"--omit=dev",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
				],
				cwd,
				env,
				this.resources,
			);
			child.stdin.end();
			child.stdout.resume();
			child.stderr.resume();
			const abort = () => {
				void stopTree(child);
				reject(new CredentialSetupError("cancelled"));
			};
			const timer = setTimeout(abort, 150000);
			signal.addEventListener("abort", abort, { once: true });
			child.on("error", () => reject(new CredentialSetupError("download")));
			child.on("close", (code) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				if (code === 0) resolve();
				else reject(new CredentialSetupError("download"));
			});
			if (signal.aborted) abort();
		});
	}
	async useManaged(server: string) {
		this.managed = true;
		this.server = server;
		await this.initialize(true, server, "bw");
		this.changed();
	}
	async signIn(
		input: {
			email: string;
			password: string;
			clientId?: string;
			clientSecret?: string;
			method?: string;
		},
		accept: (session: string, accountId: string) => Promise<void>,
	) {
		if (this.authenticating || this.controller) throw new CredentialSetupError("busy");
		this.cancel();
		this.authenticating = true;
		const generation = this.generation;
		this.phase = "signing_in";
		this.changed();
		try {
			const existing = JSON.parse(await this.command(["status"]));
			if (generation !== this.generation) return;
			if (existing.status !== "unauthenticated") await this.command(["logout"]);
			if (generation !== this.generation) return;
			this.account = undefined;
			await this.command(["config", "server", this.server]);
			if (generation !== this.generation) return;
			const env = minimalEnvironment(homedir(), {});
			Object.assign(env, {
				BITWARDENCLI_APPDATA_DIR: this.appData,
				LAPLACE_BW_MASTER: input.password,
				LANG: "en_US.UTF-8",
				LC_ALL: "en_US.UTF-8",
			});
			const args = [this.executable, "login", "--raw"];
			if (input.clientId && input.clientSecret) {
				env.BW_CLIENTID = input.clientId;
				env.BW_CLIENTSECRET = input.clientSecret;
				args.push("--apikey");
			} else {
				args.push(
					input.email,
					"--passwordenv",
					"LAPLACE_BW_MASTER",
					"--method",
					input.method ?? "0",
				);
			}
			const child = spawnLocal(process.execPath, args, this.root, env, this.resources);
			this.child = child;
			let finished = false;
			this.stdout = "";
			this.stderr = "";
			this.promptSeen = false;
			const finish = async (code: number | null) => {
				if (finished) return;
				finished = true;
				if (generation !== this.generation) {
					input.password = "";
					input.clientSecret = undefined;
					return;
				}
				clearTimeout(this.timer);
				this.child = undefined;
				this.challenge = undefined;
				let output = this.stdout.trim();
				const diagnostic = this.stderr + this.stdout;
				this.stdout = "";
				this.stderr = "";
				try {
					if (code !== 0) throw bitwardenError(diagnostic);
					if (input.clientId)
						output = (
							await this.command(
								["unlock", "--raw", "--passwordenv", "LAPLACE_BW_MASTER"],
								undefined,
								AbortSignal.timeout(30000),
								input.password,
							)
						).trim();
					if (generation !== this.generation) return;
					if (!/^[A-Za-z0-9+/=]{20,8192}$/.test(output)) throw new CredentialSetupError("failed");
					const status = JSON.parse(await this.command(["status"], output));
					if (generation !== this.generation) return;
					if (typeof status.userId !== "string") throw new CredentialSetupError("failed");
					await accept(output, status.userId);
					if (generation !== this.generation) return;
					this.account =
						typeof status.userEmail === "string" ? status.userEmail.slice(0, 254) : input.email;
					this.phase = "connected";
					this.error = undefined;
				} catch (error) {
					if (generation === this.generation) {
						this.phase = "error";
						this.error = error instanceof CredentialSetupError ? error.code : "failed";
					}
				} finally {
					input.password = "";
					input.clientSecret = undefined;
					if (generation === this.generation) this.authenticating = false;
					this.changed();
				}
			};
			child.stdout.on("data", (chunk: Buffer) => {
				if (generation !== this.generation) return;
				this.stdout += chunk.toString();
				if (this.stdout.length > 16384) this.cancel();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (generation !== this.generation) return;
				this.stderr = (this.stderr + chunk.toString()).slice(-16384);
				if (this.promptSeen) return;
				clearTimeout(this.promptTimer);
				this.promptTimer = setTimeout(() => {
					if (generation !== this.generation || !this.child) return;
					const prompt = loginPrompt(this.stderr);
					if (prompt) {
						this.promptSeen = true;
						this.challenge = prompt.challenge;
						this.methods = prompt.methods;
						this.phase = "challenge";
						this.changed();
					}
				}, 40);
			});
			child.stdin.on("error", () => {});
			child.once("error", () => {
				void finish(-1);
			});
			child.once("close", (code) => {
				void finish(code);
			});
			this.timer = setTimeout(() => {
				this.cancel();
				this.error = "expired";
				this.phase = "error";
				this.changed();
			}, 120000);
		} catch (error) {
			input.password = "";
			input.clientSecret = undefined;
			if (generation !== this.generation) return;
			this.authenticating = false;
			this.phase = "error";
			this.error = error instanceof CredentialSetupError ? error.code : "unavailable";
			this.changed();
			throw new CredentialSetupError(this.error);
		}
	}
	answer(value: string) {
		if (
			!this.child ||
			!this.challenge ||
			value.split("").some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
		)
			throw new CredentialSetupError("invalid");
		if (this.challenge === "method") {
			const index = this.methods?.indexOf(value) ?? -1;
			if (index < 0) throw new CredentialSetupError("invalid");
			// Inquirer initially selects the first option; only this one answer is accepted.
			this.child.stdin.write("\x1b[B".repeat(index) + "\n");
		} else this.child.stdin.write(value + "\n");
		this.stderr = "";
		this.promptSeen = false;
		this.challenge = undefined;
		this.methods = undefined;
		this.phase = "signing_in";
		this.changed();
	}
	cancel() {
		this.generation++;
		this.controller?.abort();
		this.authenticating = false;
		if (this.child) void stopTree(this.child);
		this.child = undefined;
		clearTimeout(this.timer);
		clearTimeout(this.promptTimer);
		this.stdout = "";
		this.stderr = "";
		this.challenge = undefined;
		this.methods = undefined;
		this.error = undefined;
		this.phase = this.account ? "connected" : "ready";
		this.changed();
	}
	async disconnect() {
		this.cancel();
		// Only our isolated CLI profile is removed. No external CLI logout or data deletion.
		await rm(this.appData, { recursive: true, force: true });
		this.account = undefined;
		this.phase = "disconnected";
		this.changed();
	}
	signedOut() {
		this.cancel();
		this.account = undefined;
		this.phase = "ready";
		this.changed();
	}
	connected(account: string) {
		this.account = account.slice(0, 254);
		this.phase = "connected";
		this.error = undefined;
		this.changed();
	}
}
