import { expect, it } from "vitest";
import { connectionName } from "../src/renderer/connection-name";

it("labels saved names using the installed runtime while preserving custom names", () => {
	expect(connectionName("Work Slack", "background-browser")).toBe("Work Slack [Background Browser]");
	expect(connectionName("Outlook", "tethered")).toBe("Outlook [Tethered]");
	expect(connectionName("Canvas [Background Browser]", "background-browser")).toBe("Canvas [Background Browser]");
	expect(connectionName("Slack [Tethered]", "background-browser")).toBe("Slack [Background Browser]");
	expect(connectionName("Custom server")).toBe("Custom server");
});
