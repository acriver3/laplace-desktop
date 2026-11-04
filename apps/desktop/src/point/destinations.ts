import { spawn } from "node:child_process";

import { providerDestination } from "@repo/project-protocol/handoff";
import { clipboard, ClipboardItem, shell } from "electron";

import { pointDestinationLabels, type PointDestination } from "../shared/point-contracts";

export function agentDestinationUrl(destination: PointDestination): string | undefined {
	switch (destination) {
		case "claude-browser":
			return providerDestination("claude", "", "browser")!;
		case "chatgpt-browser":
			return providerDestination("chatgpt", "", "browser")!;
		case "claude-desktop":
			return providerDestination("claude", "", "desktop")!;
		case "chatgpt-desktop":
			return providerDestination("chatgpt", "", "desktop")!;
		default:
			return undefined;
	}
}

/** Open a terminal without starting an agent, executing clipboard text or submitting a turn. */
async function openTerminal() {
	if (process.platform === "darwin") {
		const error = await shell.openPath("/System/Applications/Utilities/Terminal.app");
		if (error)
			throw new Error(
				"Could not open Terminal. Open your agent terminal and paste the copied screenshot path.",
			);
	} else if (process.platform === "win32") {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("cmd.exe", [], { detached: true, stdio: "ignore", windowsHide: false });
			child.once("error", () =>
				reject(new Error("Open your agent terminal and paste the copied screenshot path.")),
			);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		});
	} else throw new Error("Open your agent terminal and paste the copied screenshot path.");
}

/** Portable routes intentionally require a paste; clipboard preparation is not verified attachment. */
export async function deliverToAgent(destination: PointDestination, png: Buffer, file: string) {
	const label = pointDestinationLabels[destination];
	if (destination === "claude-cli" || destination === "codex-cli") {
		await clipboard.write([
			new ClipboardItem({
				"text/plain": `Please review this screenshot: ${JSON.stringify(file)}\n\n`,
			}),
		]);
		await openTerminal();
		return `Screenshot path copied. Paste into your running ${label} session, add your comment, and send when ready. Nothing has been submitted.`;
	}
	const url = agentDestinationUrl(destination);
	if (!url) throw new Error("This destination requires the current-chat handoff.");
	await clipboard.write([
		new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) }),
	]);
	try {
		await shell.openExternal(url);
	} catch {
		throw new Error(
			`Could not open ${label}. Your snip is copied; open the app and paste it, or choose another destination for your next snip.`,
		);
	}
	return `Snip copied. Paste into ${label}, add your comment, and send when ready. Nothing has been submitted.`;
}
