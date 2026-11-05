const status = document.querySelector("#status"),
	button = document.querySelector("#allow");
let ticket;
async function connect() {
	const tab = await chrome.tabs.getCurrent();
	const result = await chrome.runtime.sendMessage({
		action: "broker-connect",
		ticket,
		tabId: tab.id,
	});
	if (result?.connected !== true) throw Error();
}
try {
	ticket = JSON.parse(decodeURIComponent(location.hash.slice(1)));
	history.replaceState(null, "", "broker.html");
	const base = new URL(ticket.base);
	if (
		base.protocol !== "http:" ||
		base.hostname !== "127.0.0.1" ||
		!base.port ||
		base.origin !== ticket.base
	)
		throw Error();
	const response = await fetch(base.origin + "/describe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(ticket),
		credentials: "omit",
		redirect: "error",
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) throw Error();
	const { origins } = await response.json();
	if (
		!Array.isArray(origins) ||
		origins.some((o) => new URL(o).origin !== o || !o.startsWith("https://"))
	)
		throw Error();
	const permissions = { origins: origins.map((o) => o + "/*") };
	if (!origins.length || (await chrome.permissions.contains(permissions))) {
		await connect();
		status.textContent = "Chrome is ready. You can return to Laplace or your chat.";
	} else {
		status.textContent =
			"Allow Laplace to fill the approved login on: " +
			origins.join(", ") +
			". MFA and OAuth consent stay under your control.";
		button.hidden = false;
		button.onclick = async () => {
			try {
				if (await chrome.permissions.request(permissions)) {
					button.disabled = true;
					await connect();
				}
			} catch {
				status.textContent = "This request expired. Return to Desktop for a fresh review.";
			}
		};
	}
} catch {
	status.textContent =
		"This sign-in request is unavailable. Return to Laplace Desktop. No browser login was submitted.";
}
