import { expect, it } from "vitest";

import { watchSession, type SessionEvent } from "../src/session-monitor";

it("locks once per screen lock and treats a suspended timer gap as sleep", async () => {
	let clock = 0;
	let locked: boolean | undefined = false;
	const events: SessionEvent[] = [];
	const monitor = watchSession((event) => events.push(event), {
		interval: 1000,
		now: () => clock,
		probe: async () => locked,
	});
	try {
		clock += 1000;
		await monitor.tick();
		expect(events).toEqual([]);
		locked = true;
		clock += 1000;
		await monitor.tick();
		clock += 1000;
		await monitor.tick();
		expect(events).toEqual(["lock"]);
		locked = false;
		clock += 1000;
		await monitor.tick();
		clock += 60_000;
		await monitor.tick();
		expect(events).toEqual(["lock", "lock", "resume"]);
		// Unknown readings neither lock nor reset the remembered state.
		locked = undefined;
		clock += 1000;
		await monitor.tick();
		expect(events).toHaveLength(3);
	} finally {
		monitor.stop();
	}
});
