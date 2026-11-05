using System;
using System.Diagnostics;
using System.Linq;

// Starts the stable Laplace Runtime launcher without a console window, then exits.
static class LaplaceRuntimeHidden
{
	static string Quote(string value)
	{
		return "\"" + value.Replace("\"", "\\\"") + "\"";
	}

	static int Main(string[] args)
	{
		if (args.Length < 1) return 2;
		var info = new ProcessStartInfo
		{
			FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
			Arguments = "/d /s /c \"" + string.Join(" ", args.Select(Quote)) + "\"",
			CreateNoWindow = true,
			UseShellExecute = false,
			WindowStyle = ProcessWindowStyle.Hidden,
		};
		using (var process = Process.Start(info))
		{
			process.WaitForExit();
			return process.ExitCode;
		}
	}
}
