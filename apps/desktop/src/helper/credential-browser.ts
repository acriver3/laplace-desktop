import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { promisify } from "node:util";

import { minimalEnvironment } from "@repo/local-mcp-core/config";
import { spawnLocal, stopTree } from "@repo/local-mcp-core/process";

import type { BrowserChoice, CredentialBrowserState } from "../shared/credential-setup";
import { CredentialSetupError } from "./credential-errors";
import { cdpOrigin } from "./credentials-cdp";
import { browserExtensionId } from "../shared/browser-extension-id";
const exec = promisify(execFile);
const id = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
export function browserArgument(command: string, flag: string) {
	const match = command.match(
		new RegExp(`(?:^|\\s)--${flag}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`),
	);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}
export async function checkBrowser(endpoint: string, signal = AbortSignal.timeout(1500)) {
	try {
		const origin = cdpOrigin(endpoint);
		const response = await fetch(`${origin}/json/version`, { redirect: "error", signal });
		if (!response.ok || !response.body) return false;
		let raw = "";
		for await (const chunk of response.body) {
			raw += Buffer.from(chunk).toString();
			if (raw.length > 16384) return false;
		}
		const value = JSON.parse(raw);
		const socket = new URL(value.webSocketDebuggerUrl);
		return (
			/^(Chrome|HeadlessChrome|Edg)\//.test(value.Browser) &&
			socket.protocol === "ws:" &&
			socket.host === new URL(origin).host &&
			!socket.username &&
			!socket.password &&
			/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(socket.pathname)
		);
	} catch {
		return false;
	}
}
type Candidate = BrowserChoice & { executable?: string; endpoint?: string };
export class CredentialBrowser {
	private choices = new Map<string, Candidate>();
	private owned?: ChildProcessWithoutNullStreams;
	private selected = "";
	private name?: string;
	private available = false;
	private checking?: Promise<void>;
	private opening?: Promise<string>;
	private checkedAt = 0;
	private generation = 0;
	constructor(
		private root: string,
		private resources: string,
		private changed: () => void,
	) {}
	state(): CredentialBrowserState {
		return { available: this.available, owned: !!this.owned, name: this.name };
	}
	async openExistingChrome(url: string) {
		const target = new URL(url);
		if (
			target.protocol !== "chrome-extension:" ||
			target.hostname !== browserExtensionId ||
			target.pathname !== "/broker.html"
		)
			throw Error("Invalid Chrome handoff.");
		await this.discover(true);
		const chrome = [...this.choices.values()].find(
			(choice) => choice.name === "Google Chrome" && choice.executable,
		);
		if (!chrome?.executable) throw Error("Google Chrome is unavailable.");
		// Use Chrome's normal profile, without a user-data directory or debugging port.
		const child = spawn(chrome.executable, [url], {
			stdio: "ignore",
			windowsHide: true,
			detached: true,
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.unref();
	}
	async health(endpoint: string) {
		if (endpoint !== this.selected) {
			this.selected = endpoint;
			this.available = false;
			this.checkedAt = 0;
		}
		if (!this.checking && Date.now() - this.checkedAt > 5000) {
			this.checking = (async () => {
				const ok = !!endpoint && (await checkBrowser(endpoint));
				if (endpoint === this.selected) {
					this.available = ok;
					this.checkedAt = Date.now();
				}
			})().finally(() => {
				this.checking = undefined;
			});
		}
		await this.checking;
		return this.state();
	}
	async discover(installedOnly = false) {
		this.choices.clear();
		const installed =
			process.platform === "darwin"
				? [
						["Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
						["Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
						[
							"Google Chrome",
							join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
						],
					]
				: process.platform === "win32"
					? [
							[
								"Google Chrome",
								join(
									process.env.PROGRAMFILES ?? "C:\\Program Files",
									"Google/Chrome/Application/chrome.exe",
								),
							],
							[
								"Google Chrome",
								join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
							],
							[
								"Microsoft Edge",
								join(
									process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
									"Microsoft/Edge/Application/msedge.exe",
								),
							],
						]
					: [];
		for (const [name, executable] of installed)
			try {
				await access(executable!);
				this.choices.set(id(executable!), {
					id: id(executable!),
					name: name!,
					kind: "installed",
					executable,
				});
			} catch {}
		if (installedOnly)
			return [...this.choices.values()].map(({ id, name, kind }) => ({ id, name, kind }));
		let commands: string[] = [];
		try {
			if (process.platform === "darwin") {
				commands = (
					await exec("/bin/ps", ["-U", String(process.getuid!()), "-o", "command="], {
						maxBuffer: 1024 * 1024,
						timeout: 4000,
					})
				).stdout.split("\n");
			} else if (process.platform === "win32") {
				const script =
					"$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid } | ForEach-Object { $_.CommandLine }) | ConvertTo-Json -Compress";
				const output = (
					await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
						maxBuffer: 1024 * 1024,
						timeout: 5000,
						windowsHide: true,
					})
				).stdout;
				const parsed: unknown = JSON.parse(output);
				commands = Array.isArray(parsed)
					? parsed.filter((v): v is string => typeof v === "string")
					: typeof parsed === "string"
						? [parsed]
						: [];
			}
		} catch {
			/* Discovery is best effort. Installed browsers remain available. */
		}
		let count = 0;
		for (const command of commands) {
			if (
				count >= 12 ||
				!/(Google Chrome.app\/Contents\/MacOS\/Google Chrome|Microsoft Edge.app\/Contents\/MacOS\/Microsoft Edge|\\(?:chrome|msedge)\.exe)/i.test(
					command,
				) ||
				/--type=/.test(command)
			)
				continue;
			const port = browserArgument(command, "remote-debugging-port");
			const address = browserArgument(command, "remote-debugging-address");
			if (address && !["127.0.0.1", "localhost", "::1"].includes(address)) continue;
			let number = Number(port);
			if (port === "0") {
				const directory = browserArgument(command, "user-data-dir");
				if (directory && isAbsolute(directory))
					try {
						number = Number(
							(await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0],
						);
					} catch {}
			}
			if (!Number.isInteger(number) || number < 1 || number > 65535) continue;
			const endpoint = `http://${address === "::1" ? "[::1]" : "127.0.0.1"}:${number}`;
			count++;
			if (await checkBrowser(endpoint))
				this.choices.set(id(endpoint), {
					id: id(endpoint),
					name: /edge/i.test(command) ? "Microsoft Edge" : "Google Chrome",
					kind: "running",
					endpoint,
				});
		}
		return [...this.choices.values()].map(({ id, name, kind }) => ({ id, name, kind }));
	}
	async select(key: string) {
		const item = this.choices.get(key);
		if (!item?.endpoint || !(await checkBrowser(item.endpoint)))
			throw new CredentialSetupError("browser");
		if (this.owned && item.endpoint !== this.selected) await this.close();
		this.selected = item.endpoint;
		this.name = item.name;
		this.available = true;
		this.changed();
		return item.endpoint;
	}
	async launch(key: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const item = this.choices.get(key);
		if (!item?.executable || this.owned) throw new CredentialSetupError("browser");
		const generation = ++this.generation;
		const profile = join(this.root, "credential-browser", id(item.executable));
		await mkdir(profile, { recursive: true, mode: 0o700 });
		await rm(join(profile, "DevToolsActivePort"), { force: true });
		if (generation !== this.generation) throw new CredentialSetupError("cancelled");
		const child = spawnLocal(
			item.executable,
			[
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"about:blank",
			],
			this.root,
			minimalEnvironment(homedir(), {}),
			this.resources,
		);
		this.owned = child;
		child.stdin.end();
		child.stdout.resume();
		child.stderr.resume();
		let failed = false;
		child.on("error", () => {
			failed = true;
		});
		child.on("close", () => {
			if (this.owned === child) {
				this.owned = undefined;
				this.available = false;
				this.changed();
			}
		});
		try {
			for (let attempt = 0; attempt < 60; attempt++) {
				signal?.throwIfAborted();
				if (generation !== this.generation || failed || child.exitCode !== null)
					throw new CredentialSetupError("browser");
				let port = 0;
				try {
					port = Number(
						(await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
					);
				} catch {}
				const endpoint = `http://127.0.0.1:${port}`;
				if (port > 0 && port <= 65535 && (await checkBrowser(endpoint))) {
					if (generation !== this.generation) throw new CredentialSetupError("cancelled");
					this.selected = endpoint;
					this.name = `${item.name} · Laplace`;
					this.available = true;
					this.changed();
					return endpoint;
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			throw new CredentialSetupError("browser");
		} catch (error) {
			if (this.owned === child) await this.close();
			throw error;
		}
	}
	endpoint() {
		return this.selected;
	}
	/** Starts only a dedicated profile; never auto-attaches to a discovered user browser. */
	async ensureOwned(signal: AbortSignal) {
		signal.throwIfAborted();
		if (this.opening) return this.opening;
		const generation = this.generation;
		this.opening = (async () => {
			if (this.owned && (await checkBrowser(this.selected, signal))) return this.selected;
			signal.throwIfAborted();
			if (generation !== this.generation) throw new CredentialSetupError("cancelled");
			if (this.owned) await this.close();
			const launchGeneration = this.generation;
			const choices = (await this.discover(true)).filter((c) => c.kind === "installed");
			signal.throwIfAborted();
			if (launchGeneration !== this.generation) throw new CredentialSetupError("cancelled");
			if (!choices.length) throw new CredentialSetupError("browser");
			return this.launch(choices[0]!.id, signal);
		})().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	async close() {
		this.generation++;
		const child = this.owned;
		this.owned = undefined;
		if (child) {
			await stopTree(child);
			this.available = false;
		}
		this.changed();
	}
}
