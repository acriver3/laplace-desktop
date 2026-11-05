import { EventEmitter } from "node:events";

import { expect, it } from "vitest";

import { KeepAwake } from "../src/keep-awake";

it("holds the assertion only while wanted and on external power", async () => {
	let wanted = false;
	let power = true;
	const holds: Array<EventEmitter & { kill(): void; killed: boolean }> = [];
	const keepAwake = new KeepAwake(
		() => wanted,
		async () => power,
		() => {
			const child = Object.assign(new EventEmitter(), {
				killed: false,
				kill() {
					child.killed = true;
				},
			});
			holds.push(child);
			return child as never;
		},
	);
	await keepAwake.update();
	expect(keepAwake.active).toBe(false);
	wanted = true;
	await keepAwake.update();
	await keepAwake.update();
	expect(holds).toHaveLength(1);
	power = false;
	await keepAwake.update();
	expect(keepAwake.active).toBe(false);
	expect(holds[0]!.killed).toBe(true);
	power = true;
	await keepAwake.update();
	wanted = false;
	await keepAwake.update();
	expect(holds[1]!.killed).toBe(true);
	keepAwake.stop();
});
