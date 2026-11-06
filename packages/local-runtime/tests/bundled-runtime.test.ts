import { join } from "node:path";

import { expect, it } from "vitest";

import { bundledRuntimeKind } from "../src/runtime";

const exe = process.platform === "win32" ? ".exe" : "";
const home = join("/", "laplace", "runtime");
const resources = join(home, "versions", "0.1.33");
const exec = join(resources, "runtimes", "node" + exe);

it("recognizes the runtime's own node and uv by full path", () => {
	const known: [string, string, string] = [exec, exec, resources];
	expect(bundledRuntimeKind(exec, known, home)).toBe("node");
	expect(bundledRuntimeKind(join(resources, "runtimes", "uv" + exe), known, home)).toBe("uv");
	// Connectors installed under an earlier runtime version keep its node path.
	expect(
		bundledRuntimeKind(join(home, "versions", "0.1.30", "runtimes", "node" + exe), known, home),
	).toBe("node");
});

it("does not vouch for other executables", () => {
	const known: [string, string, string] = [exec, exec, resources];
	expect(bundledRuntimeKind("node", known, home)).toBeUndefined();
	expect(bundledRuntimeKind(join("/", "tmp", "node" + exe), known, home)).toBeUndefined();
	expect(
		bundledRuntimeKind(join(home, "versions", "0.1.33", "helper", "node" + exe), known, home),
	).toBeUndefined();
	expect(
		bundledRuntimeKind(join(home, "elsewhere", "runtimes", "node" + exe), known, home),
	).toBeUndefined();
});
