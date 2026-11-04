import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { UpdatesPanel } from "../src/renderer/UpdatesPanel";
import type { DesktopUpdateState, UpdatePhase } from "../src/shared/update-contracts";

function render(phase: UpdatePhase) {
	const update: DesktopUpdateState = {
		phase,
		installedVersion: "0.1.0",
		availableVersion: "0.2.0",
	};
	return renderToStaticMarkup(
		createElement(UpdatesPanel, {
			update,
			perform: async (work) => {
				await work();
			},
		}),
	);
}
test("available updates offer a download, ready updates offer an explicit restart", () => {
	expect(render("available")).toContain("Download update");
	expect(render("available")).not.toContain("Restart to install");
	expect(render("ready")).toContain("Restart to install");
	expect(render("ready")).not.toContain("Download update");
});
test("download/build/verify report phases, remain cancellable, and disable duplicate checks", () => {
	for (const phase of ["downloading", "building", "verifying"] as const) {
		const markup = render(phase);
		expect(markup).toContain('role="status"');
		expect(markup).toContain("Cancel");
		expect(markup).toContain("disabled");
		expect(markup).not.toContain("Restart to install");
	}
});
test("unmanaged installations explain bootstrap and expose no update commands", () => {
	const markup = render("unmanaged");
	expect(markup).toContain("source:install");
	expect(markup).not.toContain("Check for updates");
	expect(markup).not.toContain("Download update");
});
