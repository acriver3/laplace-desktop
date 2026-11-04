import {
	AssistantSetupView,
	ConnectionsPageView,
	HomePageView,
	SettingsPageView,
} from "@repo/ui/components/connector/page-views";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const noop = () => {};

describe("persistent Desktop page views", () => {
	it("keeps known Home summaries and assistant setup visible alongside an account loading state", () => {
		const html = renderToStaticMarkup(
			h(HomePageView, {
				gettingStarted: false,
				startTitle: "Get started",
				startDescription: "Add your first connection",
				connect: "Add connection",
				assistant: h("section", null, "Registered assistant: Codex"),
				connections: h("section", null, "Device connection: Filesystem"),
				apps: h("p", { role: "status" }, "Loading workspace apps"),
			}),
		);
		expect(html).toContain("Device connection: Filesystem");
		expect(html).toContain("Registered assistant: Codex");
		expect(html).toContain("Loading workspace apps");
		expect(html).not.toContain("Get started");
	});

	it("retains controlled search and selection with partial workspace inventory", () => {
		const html = renderToStaticMarkup(
			h(ConnectionsPageView, {
				toolbar: {
					search: "Git",
					searchIcon: null,
					onSearch: noop,
					searchLabel: "Search connections",
					filterLabel: "Show connections",
					filters: [{ value: "existing", label: "Your connections" }],
					view: "existing",
					onView: noop,
					children: h("button", null, "Add connection"),
				},
				notices: h("p", { role: "status" }, "Workspace inventory is incomplete"),
				sections: [
					{ id: "device", title: "Device", content: h("p", null, "Git tools") },
					{ id: "workspace", title: "Workspace", content: h("p", null, "GitHub") },
				],
			}),
		);
		expect(html).toContain('value="Git"');
		expect(html).toContain('aria-pressed="true">Your connections');
		expect(html).toContain('aria-labelledby="device"');
		expect(html).toContain('aria-labelledby="workspace"');
		expect(html).toContain("Workspace inventory is incomplete");
		expect(html).toContain("Git tools");
		expect(html).toContain("GitHub");
	});

	it("uses the selected assistant and explicit transport-specific follow-up steps", () => {
		const html = renderToStaticMarkup(
			h(AssistantSetupView, {
				label: "Set up your AI assistant",
				stepsLabel: "Setup steps",
				choice: {
					title: "Choose assistant",
					label: "Assistants",
					checkIcon: null,
					options: [
						{ id: "codex", label: "Codex", icon: null },
						{ id: "claude", label: "Claude", icon: null },
					],
					selected: "claude",
					onSelect: noop,
					selectionLabel: "Selected: Claude",
				},
				setup: {
					title: "Add Laplace",
					content: h("button", null, "Copy local setup instructions"),
				},
				followUpSteps: [
					{ id: "verify", title: "Verify locally", description: "Ask the assistant to list tools" },
				],
			}),
		);
		expect(html).toMatch(/aria-pressed="true" aria-label="Claude"/);
		expect(html).toContain("Copy local setup instructions");
		expect(html).toContain("Verify locally");
		expect(html).not.toContain("Sign in");
		expect(html.match(/standard-setup-number/g)).toHaveLength(3);
	});

	it("adds account settings without changing the selected Device section", () => {
		const local = [
			{ id: "device", label: "Device" },
			{ id: "credentials", label: "Credentials" },
		];
		for (const items of [local, [...local, { id: "account", label: "Account" }]]) {
			const html = renderToStaticMarkup(
				h(SettingsPageView, {
					navigationLabel: "Settings",
					items,
					activeId: "device",
					onSelect: noop,
					children: h("section", null, "Local runtime ready"),
				}),
			);
			expect(html).toMatch(/aria-current="page">Device/);
			expect(html.match(/aria-current="page"/g)).toHaveLength(1);
			expect(html).toContain("Local runtime ready");
		}
	});
});
