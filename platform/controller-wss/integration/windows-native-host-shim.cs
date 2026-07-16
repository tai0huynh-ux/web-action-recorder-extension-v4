using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

public static class WindowsNativeHostShim
{
    public static int Main()
    {
        Process child = null;
        try
        {
            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            string configPath = Path.ChangeExtension(exePath, ".config");
            string[] lines = File.ReadAllLines(configPath);
            if (lines.Length < 3) return Fail("Native host shim config is incomplete.");

            string nodePath = RequiredLine(lines[0], "node executable");
            string hostScriptPath = RequiredLine(lines[1], "native host script");
            string socketPath = RequiredLine(lines[2], "agent socket path");

            if (!File.Exists(nodePath)) return Fail("Node executable does not exist.");
            if (!File.Exists(hostScriptPath)) return Fail("Native host script does not exist.");

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = nodePath;
            startInfo.Arguments = Quote(hostScriptPath);
            startInfo.WorkingDirectory = Path.GetDirectoryName(hostScriptPath);
            startInfo.UseShellExecute = false;
            startInfo.RedirectStandardInput = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.CreateNoWindow = true;
            startInfo.EnvironmentVariables["WAR_AGENT_SOCKET_PATH"] = socketPath;

            child = Process.Start(startInfo);
            Thread stdin = new Thread(delegate() { CopyThenClose(Console.OpenStandardInput(), child.StandardInput.BaseStream); });
            Thread stdout = new Thread(delegate() { Copy(Console.OpenStandardOutput(), child.StandardOutput.BaseStream); });
            Thread stderr = new Thread(delegate() { Copy(Console.OpenStandardError(), child.StandardError.BaseStream); });
            stdin.Start();
            stdout.Start();
            stderr.Start();
            child.WaitForExit();
            stdin.Join(1000);
            stdout.Join(1000);
            stderr.Join(1000);
            return child.ExitCode;
        }
        catch (Exception error)
        {
            return Fail(error.Message);
        }
        finally
        {
            if (child != null && !child.HasExited)
            {
                try { child.Kill(); } catch { }
            }
        }
    }

    private static string RequiredLine(string value, string label)
    {
        if (value == null) throw new InvalidOperationException(label + " is missing.");
        string trimmed = value.Trim();
        if (trimmed.Length == 0) throw new InvalidOperationException(label + " is empty.");
        if (trimmed.IndexOf('\r') >= 0 || trimmed.IndexOf('\n') >= 0) throw new InvalidOperationException(label + " contains a newline.");
        return trimmed;
    }

    private static void Copy(Stream output, Stream input)
    {
        byte[] buffer = new byte[81920];
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.Write(buffer, 0, read);
            output.Flush();
        }
    }

    private static void CopyThenClose(Stream input, Stream output)
    {
        try { Copy(output, input); }
        finally
        {
            try { output.Close(); } catch { }
        }
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("native-host-shim: " + message);
        return 1;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
