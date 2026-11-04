import { beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ write: vi.fn(), open: vi.fn(), terminal: vi.fn() }));
vi.mock("electron", () => ({
	clipboard: { write: io.write },
	ClipboardItem: class {
		constructor(readonly data: Record<string, unknown>) {}
	},
	shell: { openExternal: io.open, openPath: io.terminal },
}));
import { agentDestinationUrl, deliverToAgent } from "../src/point/destinations";
import { pointSettings } from "../src/shared/point-contracts";
beforeEach(() => {
	vi.resetAllMocks();
	io.terminal.mockResolvedValue("");
});
it("migrates old settings to Codex and rejects arbitrary launch destinations", () => {
	expect(pointSettings.parse({ enabled: true, shortcut: "Control+L" }).destination).toBe(
		"codex-desktop",
	);
	expect(
		pointSettings.safeParse({
			enabled: true,
			shortcut: "Control+L",
			destination: "file:///tmp/run",
		}).success,
	).toBe(false);
});
it.each(["claude-browser", "chatgpt-browser", "claude-desktop", "chatgpt-desktop"] as const)(
	"prepares an image and opens %s without embedding the screenshot or local path in a URL",
	async (destination) => {
		const message = await deliverToAgent(
			destination,
			Buffer.from("fixture"),
			"/private/secret.png",
		);
		expect(io.write).toHaveBeenCalledOnce();
		expect(io.write.mock.calls[0][0][0].data["image/png"]).toBeInstanceOf(Blob);
		expect(io.open).toHaveBeenCalledWith(agentDestinationUrl(destination));
		expect(io.open.mock.calls[0][0]).not.toMatch(/secret|fixture/);
		expect(message).toMatch(/Paste/);
		expect(message).not.toMatch(/added|attached/);
	},
);
it("retains copied image and reports a missing desktop app", async () => {
	io.open.mockRejectedValue(new Error("no handler"));
	await expect(
		deliverToAgent("claude-desktop", Buffer.from("fixture"), "/tmp/test.png"),
	).rejects.toThrow("Could not open Claude desktop");
	expect(io.write).toHaveBeenCalledOnce();
});
it.runIf(process.platform === "darwin")(
	"copies a CLI image reference without executing it",
	async () => {
		const message = await deliverToAgent(
			"claude-cli",
			Buffer.from("fixture"),
			'/tmp/a "quoted" snip.png',
		);
		expect(io.write.mock.calls[0][0][0].data["text/plain"]).toContain(
			JSON.stringify('/tmp/a "quoted" snip.png'),
		);
		expect(io.terminal).toHaveBeenCalledWith("/System/Applications/Utilities/Terminal.app");
		expect(io.open).not.toHaveBeenCalled();
		expect(message).toContain("running Claude Code CLI session");
	},
);
