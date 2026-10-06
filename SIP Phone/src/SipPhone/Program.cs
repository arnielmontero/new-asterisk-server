namespace SipPhone;

static class Program
{
    private static Mutex? _singleInstance;

    [STAThread]
    static void Main()
    {
        // Two copies would fight over the same registration (the PBX keeps one contact per phone).
        _singleInstance = new Mutex(true, @"Local\LanCommsSipPhone", out bool first);
        if (!first)
        {
            MessageBox.Show("SIP Phone is already running.", "SIP Phone", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.ThreadException += (_, e) => ReportCrash(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => ReportCrash(e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) => { WriteCrashLog(e.Exception); e.SetObserved(); };
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        Application.Run(new MainForm());
        GC.KeepAlive(_singleInstance);
    }

    private static void ReportCrash(Exception? ex)
    {
        var path = WriteCrashLog(ex);
        MessageBox.Show($"SIP Phone hit an unexpected problem.\n\n{ex?.Message}\n\nDetails were saved to:\n{path}",
            "SIP Phone", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static string WriteCrashLog(Exception? ex)
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SIP Phone");
        var path = Path.Combine(folder, "crash.log");
        try
        {
            Directory.CreateDirectory(folder);
            File.AppendAllText(path, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {ex}\n\n");
        }
        catch (IOException) { }
        return path;
    }
}
