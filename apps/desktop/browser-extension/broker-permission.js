const status = document.querySelector("#status"),
	button = document.querySelector("#allow");
try {
	const origin = decodeURIComponent(location.hash.slice(1));
	if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw Error();
	history.replaceState(null, "", "broker-permission.html");
	status.textContent =
		"Allow Laplace to use the approved login on " +
		origin +
		". MFA and consent remain yours to complete.";
	button.onclick = async () => {
		try {
			if (await chrome.permissions.request({ origins: [origin + "/*"] })) {
				status.textContent = "Access allowed. Return to your sign-in tab; Laplace will continue.";
				button.hidden = true;
			}
		} catch {
			status.textContent = "Could not grant access. Check Chrome extension settings.";
		}
	};
} catch {
	status.textContent = "This site access request is unavailable.";
	button.hidden = true;
}
