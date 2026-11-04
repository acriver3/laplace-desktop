import { createHash, randomUUID } from "node:crypto";

import { clipboard, ClipboardItem } from "electron";

import { pointChatLink, type PointTarget } from "../shared/point-contracts";
import { waitFor } from "./handoff";
import { PointNative, type NativeWindow } from "./native";

async function fingerprint(items: Electron.ClipboardItem[]) {
	const hash = createHash("sha256");
	let bytes = 0;
	for (const item of items)
		for (const type of [...item.types].sort()) {
			hash.update(type);
			const value = await item.getType(type);
			const buffer =
				value instanceof Blob
					? Buffer.from(await value.arrayBuffer())
					: Buffer.from(JSON.stringify(value));
			bytes += buffer.length;
			if (bytes > 64 * 1024 * 1024)
				throw new Error(
					"Clipboard is too large to preserve. Copy it elsewhere before using Point.",
				);
			hash.update(buffer);
		}
	return hash.digest("hex");
}

/** Keep all formats, and never restore over a clipboard the user changed. */
export async function withPointClipboard<T>(
	work: (lease: {
		text(value: string): Promise<void>;
		image(png: Buffer): Promise<void>;
		adopt(): Promise<void>;
	}) => Promise<T>,
): Promise<T> {
	const snapshot = await clipboard.read();
	await fingerprint(snapshot);
	// Electron read items are lazy read-only handles, and cannot be passed back to write.
	// Materialize every format before changing the system clipboard.
	const original = await Promise.all(
		snapshot.map(
			async (item) =>
				new ClipboardItem(
					Object.fromEntries(
						await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
					),
				),
		),
	);
	let owned: string | undefined;
	const adopt = async () => {
		owned = await fingerprint(await clipboard.read());
	};
	const write = async (item: Electron.ClipboardItem) => {
		await clipboard.write([item]);
		await adopt();
	};
	try {
		return await work({
			text: (value) => write(new ClipboardItem({ "text/plain": value })),
			image: (png) =>
				write(
					new ClipboardItem({
						"image/png": new Blob([new Uint8Array(png)], { type: "image/png" }),
					}),
				),
			adopt,
		});
	} finally {
		if (owned && (await fingerprint(await clipboard.read())) === owned)
			await clipboard.write(original);
	}
}

export async function readChatTarget(
	native: PointNative,
	window: NativeWindow,
): Promise<PointTarget> {
	return withPointClipboard(async (lease) => {
		await lease.text(`laplace-point:${randomUUID()}`);
		await native.call("copy-link", window);
		const link = await waitFor(
			() => clipboard.readText(),
			(value) => !!pointChatLink(value),
			2000,
		);
		await lease.adopt();
		return { ...window, chatLink: pointChatLink(link)! };
	});
}

export async function verifyChatTarget(native: PointNative, target: PointTarget) {
	const current = await readChatTarget(native, target);
	if (current.chatLink !== target.chatLink)
		throw new Error(
			"The Codex chat changed during capture. Return to the original chat and retry; your snip is retained.",
		);
}
