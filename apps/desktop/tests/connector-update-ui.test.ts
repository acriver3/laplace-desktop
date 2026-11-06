import type { ConnectorUpdateStatus } from "@repo/local-mcp-core/connector-updates";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import {
	ConnectorUpdateControl,
	ConnectorUpdateDialog,
	ConnectorUpdateIcon,
	showsUpdateIcon,
} from "../src/renderer/ConnectorUpdateButton";

const row = (patch: Partial<ConnectorUpdateStatus> = {}): ConnectorUpdateStatus => ({
	id: "canvas-session",
	name: "Canvas",
	version: "0.1.0-laplace.1",
	availableVersion: "0.1.0-laplace.2",
	pinned: false,
	phase: "idle",
	...patch,
});
const run = async () => true;
const dialog = (r: ConnectorUpdateStatus, busy = false) =>
	renderToStaticMarkup(
		createElement(ConnectorUpdateDialog, { row: r, busy, run, close: () => {} }),
	);
const control = (r?: ConnectorUpdateStatus) =>
	renderToStaticMarkup(createElement(ConnectorUpdateControl, { row: r, busy: false, run }));

test("the icon appears only for an available, unpinned update or one in progress", () => {
	expect(showsUpdateIcon(row())).toBe(true);
	expect(showsUpdateIcon(row({ availableVersion: undefined }))).toBe(false);
	expect(showsUpdateIcon(row({ pinned: true }))).toBe(false);
	expect(showsUpdateIcon(row({ pinned: true, phase: "downloading" }))).toBe(true);
	expect(showsUpdateIcon(undefined)).toBe(false);
	expect(control(row({ availableVersion: undefined }))).toBe("");
	expect(control(undefined)).toBe("");
});

test("the icon is a labelled button that opens a confirmation instead of installing", () => {
	const markup = control(row());
	expect(markup).toContain("<button");
	expect(markup).toContain('aria-haspopup="dialog"');
	expect(markup).toContain("Update available for Canvas: 0.1.0-laplace.1 to 0.1.0-laplace.2");
	expect(markup).not.toContain("<dialog");
	const working = renderToStaticMarkup(
		createElement(ConnectorUpdateIcon, { row: row({ phase: "installing" }), onOpen: () => {} }),
	);
	expect(working).toContain("Canvas: installing update");
	expect(working).toContain("animate-spin");
});

test("the dialog lets the user install, keep this version, or decline", () => {
	const markup = dialog(row());
	expect(markup).toContain("Update Canvas");
	expect(markup).toContain("Installed 0.1.0-laplace.1 · Available 0.1.0-laplace.2");
	expect(markup).toContain("Install 0.1.0-laplace.2");
	expect(markup).toContain("Keep this version");
	expect(markup).toContain("Not now");
	expect(markup).not.toMatch(/<button[^>]* disabled=""[^>]*>Install/);
});

test("blocked updates explain why and cannot be installed from the dialog", () => {
	const markup = dialog(
		row({ blocked: true, message: "This release requires new browser permission approval." }),
	);
	expect(markup).toContain("requires new browser permission approval");
	expect(markup).toMatch(/<button[^>]* disabled=""[^>]*>Install 0\.1\.0-laplace\.2/);
	// A failed attempt is only a hint: retrying stays possible.
	const retry = dialog(
		row({ blocked: false, message: "Previous update failed. Use manual update to retry." }),
	);
	expect(retry).not.toMatch(/<button[^>]* disabled=""[^>]*>Install/);
});

test("downloads can be cancelled and finished updates report up to date", () => {
	const downloading = dialog(row({ phase: "downloading" }));
	expect(downloading).toContain("Cancel download");
	expect(downloading).not.toContain("Install 0.1.0");
	expect(dialog(row({ version: "0.1.0-laplace.2", availableVersion: undefined }))).toContain(
		"Canvas is up to date.",
	);
	expect(dialog(row(), true)).toMatch(/<button[^>]* disabled=""[^>]*>Updating…/);
});
