using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("FALCO Factory Studio")]
[assembly: AssemblyProduct("FALCO Factory Studio")]
[assembly: AssemblyCompany("GTL AI")]
[assembly: AssemblyDescription("Opens the Falco Studio launcher in this folder")]

internal static class StudioLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string launcher = Path.Combine(root, "main.cmd");
        if (!File.Exists(launcher)) launcher = Path.Combine(root, "ABRIR_FALCO_STUDIO.cmd");
        bool available = File.Exists(launcher) && File.Exists(Path.Combine(root, "package.json"));
        if (args.Length == 1 && args[0] == "--launcher-check") return available ? 0 : 1;

        if (!available)
        {
            MessageBox.Show("No se encontro el lanzador de Studio. Manten este archivo junto a main.cmd y package.json, dentro de la carpeta completa de Falco Factory.",
                "FALCO Factory Studio", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        if (args.Length > 1 || (args.Length == 1 && args[0] != "--check")) return 2;
        try
        {
            string logDirectory = Path.Combine(root, ".falco-operations");
            Directory.CreateDirectory(logDirectory);
            string logPath = Path.Combine(logDirectory, "studio-launcher.log");
            using (var log = new StreamWriter(new FileStream(logPath, FileMode.Create, FileAccess.Write, FileShare.Read)))
            using (var process = new Process())
            {
                log.AutoFlush = true;
                process.StartInfo = new ProcessStartInfo {
                    FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                    Arguments = "/d /c " + Path.GetFileName(launcher) + (args.Length == 1 ? " --check" : ""),
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                process.StartInfo.EnvironmentVariables["FALCO_STUDIO_BACKGROUND"] = "1";
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                if (process.ExitCode != 0)
                    MessageBox.Show("Studio no pudo iniciarse o se detuvo con un error. Revisa el registro:\n" + logPath,
                        "FALCO Factory Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return process.ExitCode;
            }
        }
        catch
        {
            MessageBox.Show("No se pudo abrir Studio. Abre main.cmd directamente para revisar el inicio.",
                "FALCO Factory Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
