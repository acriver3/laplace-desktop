import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const source = await readFile(new URL("../../../packages/ui/brand/app-icon.svg", import.meta.url));
const resources = new URL("../resources/", import.meta.url);
await mkdir(resources, { recursive: true });
await sharp(source)
	.resize(512)
	.png()
	.toFile(fileURLToPath(new URL("icon.png", resources)));
const png = await sharp(source).resize(256).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await writeFile(new URL("icon.ico", resources), Buffer.concat([header, png]));
if (process.platform === "darwin") {
	const chunks = [];
	for (const [type, size] of [
		["ic07", 128],
		["ic08", 256],
		["ic09", 512],
		["ic10", 1024],
	]) {
		const png = await sharp(source).resize(size).png().toBuffer();
		const chunk = Buffer.alloc(8);
		chunk.write(type);
		chunk.writeUInt32BE(png.length + 8, 4);
		chunks.push(chunk, png);
	}
	const contents = Buffer.concat(chunks),
		header = Buffer.alloc(8);
	header.write("icns");
	header.writeUInt32BE(contents.length + 8, 4);
	await writeFile(new URL("icon.icns", resources), Buffer.concat([header, contents]));
}
