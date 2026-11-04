const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { app, session } = require("electron");

if (!process.env.LAPLACE_COOKIE_TEST_ROOT)
	throw new Error("An isolated cookie test root is required");
app.setPath("userData", process.env.LAPLACE_COOKIE_TEST_ROOT);
app.setName("Laplace Cookie Test");
const cookieName = "__Host-laplace.session_token";
const cookieValue = "synthetic-test-session";
const server = createServer((request, response) => {
	response.setHeader("Content-Type", "application/json");
	response.setHeader("Cache-Control", "no-store");
	if (request.method === "POST" && request.url === "/api/auth/desktop/exchange") {
		response.setHeader(
			"Set-Cookie",
			`${cookieName}=${cookieValue}; Secure; HttpOnly; SameSite=Lax; Path=/`,
		);
		response.end(JSON.stringify({ success: true }));
	} else
		response.end(
			JSON.stringify({
				cookiePresent: request.headers.cookie?.includes(`${cookieName}=${cookieValue}`) === true,
			}),
		);
});
void (async () => {
	let local,
		hosted,
		exitCode = 0;
	try {
		await app.whenReady();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const origin = `http://127.0.0.1:${server.address().port}`;
		local = session.fromPartition("persist:cookie-test-local");
		hosted = session.fromPartition("persist:cookie-test-hosted");
		const response = await local.fetch(`${origin}/api/auth/desktop/exchange`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify({ code: "synthetic-grant" }),
			credentials: "include",
			redirect: "error",
		});
		assert.equal(response.status, 200);
		const cookies = await local.cookies.get({ url: origin, name: cookieName });
		assert.equal(cookies.length, 1);
		assert.equal(cookies[0].httpOnly, true);
		assert.equal(cookies[0].secure, true);
		assert.equal(cookies[0].hostOnly, true);
		assert.equal(cookies[0].value === cookieValue, true);
		assert.equal(
			(await (await local.fetch(origin, { credentials: "include" })).json()).cookiePresent,
			true,
		);
		assert.equal((await hosted.cookies.get({ url: origin })).length, 0);
		assert.equal(
			(await (await hosted.fetch(origin, { credentials: "include" })).json()).cookiePresent,
			false,
		);
		console.log(
			"PASS Electron cookies: session.fetch stores/sends the host-only Secure HttpOnly session; profile partitions stay isolated.",
		);
	} catch {
		exitCode = 1;
		console.error("FAIL Electron cookie transport check. No cookie values were logged.");
	} finally {
		await local?.clearStorageData();
		await hosted?.clearStorageData();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		app.exit(exitCode);
	}
})();
