import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

/** Stable client entry outside Squirrel's rotating version directories. */
export async function stableBridge(root: string, nodePath: string, bridgePath: string) {
	if (process.platform !== "win32") return { nodePath, bridgePath };
	const directory = join(root, "client-launcher");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const node = join(directory, "node.exe"),
		launcher = join(directory, "bridge.cjs");
	try {
		await copyFile(nodePath, node, 1);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const source = `const {readFileSync}=require('node:fs'); const {join,isAbsolute}=require('node:path'); const {spawn}=require('node:child_process'); const value=JSON.parse(readFileSync(join(__dirname,'target.json'),'utf8')); if(!isAbsolute(value.node)||!isAbsolute(value.bridge)) throw Error('Invalid bridge target'); const child=spawn(value.node,[value.bridge,...process.argv.slice(2)],{stdio:'inherit',windowsHide:true}); child.on('error',()=>process.exit(1)); child.on('exit',(code)=>process.exit(code??1)); for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));`;
	try {
		await writeFile(launcher, source, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await readFile(launcher, "utf8")) !== source) throw Error("Stable launcher needs repair");
	}
	const temporary = join(directory, randomUUID() + ".json");
	await writeFile(temporary, JSON.stringify({ node: nodePath, bridge: bridgePath }), {
		flag: "wx",
		mode: 0o600,
	});
	await rename(temporary, join(directory, "target.json"));
	return { nodePath: node, bridgePath: launcher };
}
