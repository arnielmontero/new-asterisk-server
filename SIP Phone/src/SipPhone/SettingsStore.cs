using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SipPhone.Core;

namespace SipPhone;

/// <summary>
/// Settings and call history under %APPDATA%\SIP Phone. The SIP password is encrypted with Windows DPAPI for the
/// current user: it is never written as plain text and cannot be read by another Windows account.
/// </summary>
public sealed class SettingsStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("LAN-Comms-SIPPhone-v1");
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public string Folder { get; }
    private string SettingsPath => Path.Combine(Folder, "settings.json");
    private string HistoryPath => Path.Combine(Folder, "calls.json");

    public SettingsStore(string? folder = null)
    {
        // SIPPHONE_DATA_DIR keeps settings somewhere else (portable use, testing); default is %APPDATA%\SIP Phone.
        var overrideDir = Environment.GetEnvironmentVariable("SIPPHONE_DATA_DIR");
        Folder = folder
            ?? (!string.IsNullOrWhiteSpace(overrideDir) ? overrideDir
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SIP Phone"));
    }

    private sealed class Stored
    {
        public string Server { get; set; } = "";
        public int Port { get; set; } = 5060;
        public string Username { get; set; } = "";
        public string PasswordProtected { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public int RegisterExpirySeconds { get; set; } = 300;
        public bool AutoAnswerPages { get; set; } = true;
        public int LocalSipPort { get; set; }
        public string InputDevice { get; set; } = "";
        public string OutputDevice { get; set; } = "";
        public int Volume { get; set; } = 80;
    }

    public PhoneSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new PhoneSettings();
            var stored = JsonSerializer.Deserialize<Stored>(File.ReadAllText(SettingsPath)) ?? new Stored();
            string password = "";
            if (stored.PasswordProtected.Length > 0)
            {
                try
                {
                    password = Encoding.UTF8.GetString(ProtectedData.Unprotect(
                        Convert.FromBase64String(stored.PasswordProtected), Entropy, DataProtectionScope.CurrentUser));
                }
                catch (CryptographicException) { /* saved by another Windows user: ask again */ }
            }
            return new PhoneSettings
            {
                Server = stored.Server, Port = stored.Port, Username = stored.Username, Password = password,
                DisplayName = stored.DisplayName, RegisterExpirySeconds = stored.RegisterExpirySeconds,
                AutoAnswerPages = stored.AutoAnswerPages, LocalSipPort = stored.LocalSipPort,
                InputDevice = stored.InputDevice, OutputDevice = stored.OutputDevice,
                Volume = Math.Clamp(stored.Volume, 0, 100),
            };
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return new PhoneSettings(); // unreadable file: start clean rather than crash
        }
    }

    public void Save(PhoneSettings s)
    {
        Directory.CreateDirectory(Folder);
        var stored = new Stored
        {
            Server = s.Server, Port = s.Port, Username = s.Username,
            PasswordProtected = s.Password.Length == 0 ? "" : Convert.ToBase64String(
                ProtectedData.Protect(Encoding.UTF8.GetBytes(s.Password), Entropy, DataProtectionScope.CurrentUser)),
            DisplayName = s.DisplayName, RegisterExpirySeconds = s.RegisterExpirySeconds, AutoAnswerPages = s.AutoAnswerPages,
            LocalSipPort = s.LocalSipPort, InputDevice = s.InputDevice, OutputDevice = s.OutputDevice, Volume = s.Volume,
        };
        WriteAtomically(SettingsPath, JsonSerializer.Serialize(stored, Json));
    }

    public sealed record HistoryEntry(DateTime TimeLocal, bool Incoming, string Party, bool Answered, double Seconds, string Result);

    public List<HistoryEntry> LoadHistory()
    {
        try
        {
            return File.Exists(HistoryPath)
                ? JsonSerializer.Deserialize<List<HistoryEntry>>(File.ReadAllText(HistoryPath)) ?? new()
                : new();
        }
        catch (Exception ex) when (ex is IOException or JsonException) { return new(); }
    }

    public void SaveHistory(List<HistoryEntry> entries)
    {
        try
        {
            Directory.CreateDirectory(Folder);
            WriteAtomically(HistoryPath, JsonSerializer.Serialize(entries.TakeLast(100).ToList(), Json));
        }
        catch (IOException) { /* history is a convenience */ }
    }

    private static void WriteAtomically(string path, string content)
    {
        var temp = path + ".tmp";
        File.WriteAllText(temp, content, Encoding.UTF8);
        File.Move(temp, path, overwrite: true);
    }
}
