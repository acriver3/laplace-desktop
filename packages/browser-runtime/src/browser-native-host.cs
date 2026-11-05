using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

// A console-subsystem launcher preserves Chrome's binary stdio framing.
// Electron's GUI stdout is unsuitable on Windows. No shell or provider data.
class BrowserNativeHost {
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static async Task Pump(Stream source, Stream destination) {
        byte[] bytes = new byte[8192]; int count;
        while ((count = await source.ReadAsync(bytes, 0, bytes.Length)) > 0) {
            await destination.WriteAsync(bytes, 0, count);
            await destination.FlushAsync();
        }
    }
    static int Main(string[] args) {
        if (args.Length < 1 || args[0] != "chrome-extension://gfiilmbgjaoebjpjifdhbedmapcbeokl/") return 1;
        try {
            string runtimes = AppDomain.CurrentDomain.BaseDirectory;
            var info = new ProcessStartInfo(Path.Combine(runtimes, "node.exe"),
                Quote(Path.GetFullPath(Path.Combine(runtimes, "..", "helper", "browser-native-entry.cjs"))) + " " + Quote(args[0]));
            info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            using (var child = Process.Start(info)) {
                // Console pipe reads may block synchronously. Keep all pumps off
                // the thread that waits for the child; flush every binary frame.
                Task input = Task.Run(async () => { try { await Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); } finally { child.StandardInput.Close(); } });
                Task output = Task.Run(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
                Task errors = Task.Run(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
                child.WaitForExit(); output.Wait(); errors.Wait();
                return child.ExitCode;
            }
        } catch { return 1; }
    }
}
