const status = document.querySelector("#status");
async function send(action, extras = {}) {
	const result = await chrome.runtime.sendMessage({ action, ...extras });
	if (result?.error) throw new Error(result.error);
	return result;
}
async function showSessions() {
	const result = await send("status"),
		container = document.querySelector("#sessions");
	container.replaceChildren();
	for (const session of result.sessions) {
		const row = document.createElement("p"),
			button = document.createElement("button");
		row.textContent = session.label + " · " + session.workspace + " ";
		button.textContent = "Disconnect";
		button.onclick = async () => {
			try {
				await send("disconnect", { id: session.id });
				await showSessions();
				status.textContent = "Disconnected.";
			} catch (error) {
				status.textContent = error.message;
			}
		};
		row.append(button);
		container.append(row);
	}
	if (!result.sessions.length) container.textContent = "None yet.";
}

showSessions().catch(() => {
	status.textContent = "Open Laplace Desktop to manage connections.";
});
