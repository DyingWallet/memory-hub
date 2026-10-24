// run-hidden.cs - start a command with no console window and no ShellExecute.
//
// Why this exists: the scheduled tasks used to go through
//   wscript.exe run-hidden.vbs -> WScript.Shell.Run
// WScript.Shell.Run is ShellExecute, and ShellExecute runs the attachment /
// "Open File - Security Warning" check. For a freshly extracted executable that
// dialog appears and blocks the task until someone clicks it - which showed up
// as a node.exe prompt every minute and 800704C7 (ERROR_CANCELLED) in the task
// log.
//
// Process.Start with UseShellExecute=false goes through CreateProcess, and
// CreateNoWindow sets CREATE_NO_WINDOW: no window, no attachment check.
//
// Build: powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1
// Target: winexe (GUI subsystem) so the launcher itself never allocates a console.

using System;
using System.Diagnostics;
using System.Text;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length == 0) return 2;

        // args[0] is the executable; everything after it is its command line.
        var commandLine = new StringBuilder();
        for (var i = 1; i < args.Length; i++)
        {
            if (commandLine.Length > 0) commandLine.Append(' ');
            commandLine.Append(Quote(args[i]));
        }

        var start = new ProcessStartInfo(args[0])
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Environment.CurrentDirectory,
            Arguments = commandLine.ToString(),
        };

        try
        {
            Process.Start(start);
            return 0;
        }
        catch
        {
            return 3;
        }
    }

    // Minimal Windows command-line quoting: quote only when needed.
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
