import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
/** Unknown is deliberately different from idle, including headless sessions. */
export async function computerIdleSeconds(): Promise<number | undefined> {
	try {
		if (process.platform === "darwin") {
			const { stdout } = await execute("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], {
				timeout: 3000,
				maxBuffer: 1024 * 1024,
			});
			const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
			if (match) return Number(match[1]) / 1e9;
		}
		if (process.platform === "win32") {
			const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LaplaceIdle { [StructLayout(LayoutKind.Sequential)] public struct Info { public uint size; public uint tick; } [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref Info i); public static double Seconds() { Info i = new Info(); i.size = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) return -1; return unchecked((uint)Environment.TickCount - i.tick) / 1000.0; } }'; [LaplaceIdle]::Seconds().ToString([Globalization.CultureInfo]::InvariantCulture)`;
			const { stdout } = await execute(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", script],
				{ timeout: 10000, maxBuffer: 10000, windowsHide: true },
			);
			const value = Number(stdout.trim());
			if (Number.isFinite(value) && value >= 0) return value;
		}
	} catch {
		/* Without a trustworthy OS reading, automatic application remains deferred. */
	}
	return undefined;
}
