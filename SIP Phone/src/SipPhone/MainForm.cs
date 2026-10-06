using System.Runtime.InteropServices;
using System.Text;
using SipPhone.Core;

namespace SipPhone;

public sealed class MainForm : Form
{
    private static readonly Color Green = Color.FromArgb(40, 167, 69);
    private static readonly Color Red = Color.FromArgb(205, 52, 52);
    private static readonly Color Amber = Color.FromArgb(230, 150, 20);
    private static readonly Color Grey = Color.FromArgb(150, 150, 150);

    private readonly SettingsStore _store;
    private PhoneSettings _settings;
    private readonly WindowsAudioFactory _audio;
    private readonly SipPhoneClient _client;
    private readonly List<SettingsStore.HistoryEntry> _history;
    private readonly StringBuilder _log = new();
    private LogForm? _logForm;
    private string _notice = "";
    private DateTime _noticeUntil;

    // header
    private readonly Label _dot = new() { Text = "●", AutoSize = true, Font = new Font("Segoe UI", 14f), ForeColor = Grey, Margin = new Padding(0, 2, 4, 0) };
    private readonly Label _regText = new() { AutoSize = false, AutoEllipsis = true, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
    // display
    private readonly Label _state = new() { Dock = DockStyle.Top, Height = 34, Font = new Font("Segoe UI", 15f, FontStyle.Bold), TextAlign = ContentAlignment.MiddleCenter };
    private readonly Label _remote = new() { Dock = DockStyle.Top, Height = 28, Font = new Font("Segoe UI", 12f), TextAlign = ContentAlignment.MiddleCenter };
    private readonly Label _timer = new() { Dock = DockStyle.Top, Height = 24, Font = new Font("Segoe UI", 10.5f), ForeColor = SystemColors.GrayText, TextAlign = ContentAlignment.MiddleCenter };
    private readonly Label _noticeLabel = new() { Dock = DockStyle.Fill, Font = new Font("Segoe UI", 9f), ForeColor = Color.Firebrick, TextAlign = ContentAlignment.TopCenter };
    // dialing
    private readonly TextBox _number = new() { Dock = DockStyle.Fill, Font = new Font("Segoe UI", 16f), TextAlign = HorizontalAlignment.Center, MaxLength = 32 };
    private readonly Button _call = Make("Call", Green);
    private readonly Button _answer = Make("Answer", Green);
    private readonly Button _hangup = Make("Hang up", Red);
    private readonly Button _mute = Make("Mute", null);
    private readonly Button _hold = Make("Hold", null);
    private readonly Button _echo = Make("Echo test (600)", null);
    private readonly Button _quickA = Make("", null);
    private readonly Button _quickB = Make("", null);
    private readonly TrackBar _volume = new() { Minimum = 0, Maximum = 100, TickStyle = TickStyle.None, Dock = DockStyle.Fill };
    private readonly ListView _historyList = new() { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.Nonclickable, MultiSelect = false };
    private readonly System.Windows.Forms.Timer _tick = new() { Interval = 500 };
    private readonly string _ownExtension;
    private readonly ToolTip _tooltip = new();

    public MainForm()
    {
        _store = new SettingsStore();
        _settings = _store.Load();
        _history = _store.LoadHistory();
        _ownExtension = new string(_settings.Username.TakeWhile(char.IsDigit).ToArray());

        _audio = new WindowsAudioFactory(() => _settings);
        _audio.Warning += m => Ui(() => ShowNotice(m, 10));
        _client = new SipPhoneClient(_audio);
        _client.RegistrationChanged += (_, _) => Ui(RefreshUi);
        _client.CallStateChanged += _ => Ui(RefreshUi);
        _client.IncomingCall += call => Ui(() => OnIncoming(call));
        _client.CallEnded += end => Ui(() => OnCallEnded(end));
        _client.Trace += AppendLog;

        Text = "SIP Phone";
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.5f);
        ClientSize = new Size(380, 800);
        MinimumSize = new Size(Width - 40, 700);
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        BuildLayout();
        WireEvents();
        _volume.Value = Math.Clamp(_settings.Volume, 0, 100);
        FillHistory();
        RefreshUi();
    }

    private static Button Make(string text, Color? back)
    {
        var b = new Button { Text = text, Dock = DockStyle.Fill, Font = new Font("Segoe UI", 11f, FontStyle.Bold), FlatStyle = FlatStyle.Flat, Margin = new Padding(3), UseVisualStyleBackColor = back is null };
        if (back is { } c) { b.BackColor = c; b.ForeColor = Color.White; b.FlatAppearance.BorderSize = 0; }
        else { b.Font = new Font("Segoe UI", 9.5f); b.FlatAppearance.BorderColor = Color.Silver; }
        return b;
    }

    // ------------------------------------------------------------------ layout

    private void BuildLayout()
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(10, 6, 10, 8) };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void AddRow(Control c, SizeType type, float size) { root.RowStyles.Add(new RowStyle(type, size)); root.Controls.Add(c); }

        // header: status dot, text, settings, log
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1 };
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var settingsButton = new Button { Text = "Settings", AutoSize = true, FlatStyle = FlatStyle.System, Margin = new Padding(2, 4, 2, 4) };
        var logButton = new Button { Text = "SIP log", AutoSize = true, FlatStyle = FlatStyle.System, Margin = new Padding(2, 4, 2, 4) };
        header.Controls.Add(_dot, 0, 0);
        header.Controls.Add(_regText, 1, 0);
        header.Controls.Add(settingsButton, 2, 0);
        header.Controls.Add(logButton, 3, 0);
        settingsButton.Click += (_, _) => OpenSettings();
        logButton.Click += (_, _) => OpenLog();
        AddRow(header, SizeType.Absolute, 42);

        // display
        var display = new Panel { Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.FromArgb(246, 248, 250), Padding = new Padding(4) };
        display.Controls.Add(_noticeLabel);
        display.Controls.Add(_timer);
        display.Controls.Add(_remote);
        display.Controls.Add(_state);
        AddRow(display, SizeType.Absolute, 132);

        // number
        var numberRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        numberRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        numberRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        numberRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 52));
        var back = Make("⌫", null);
        back.Font = new Font("Segoe UI", 12f);
        back.Click += (_, _) => { if (_number.TextLength > 0) _number.Text = _number.Text[..^1]; _number.SelectionStart = _number.TextLength; _number.Focus(); };
        numberRow.Controls.Add(_number, 0, 0);
        numberRow.Controls.Add(back, 1, 0);
        AddRow(numberRow, SizeType.Absolute, 46);

        // keypad
        var pad = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 4 };
        for (int i = 0; i < 3; i++) pad.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33f));
        for (int i = 0; i < 4; i++) pad.RowStyles.Add(new RowStyle(SizeType.Percent, 25));
        string[] keys = { "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#" };
        for (int i = 0; i < keys.Length; i++)
        {
            var key = keys[i];
            var b = Make(key, null);
            b.Font = new Font("Segoe UI", 14f);
            b.Click += (_, _) => PressKey(key[0]);
            pad.Controls.Add(b, i % 3, i / 3);
        }
        AddRow(pad, SizeType.Percent, 100);

        // call / answer / hang up
        var actions = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        actions.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        var left = new Panel { Dock = DockStyle.Fill };
        _call.Dock = DockStyle.Fill; _answer.Dock = DockStyle.Fill;
        left.Controls.Add(_call); left.Controls.Add(_answer);
        actions.Controls.Add(left, 0, 0);
        actions.Controls.Add(_hangup, 1, 0);
        AddRow(actions, SizeType.Absolute, 56);

        // mute / hold / echo
        var features = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3 };
        features.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        features.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 28));
        features.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 28));
        features.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 44));
        features.Controls.Add(_mute, 0, 0);
        features.Controls.Add(_hold, 1, 0);
        features.Controls.Add(_echo, 2, 0);
        AddRow(features, SizeType.Absolute, 42);

        // quick dial
        var quick = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        quick.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        quick.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        quick.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        quick.Controls.Add(_quickA, 0, 0);
        quick.Controls.Add(_quickB, 1, 0);
        AddRow(quick, SizeType.Absolute, 42);

        // volume
        var volumeRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        volumeRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        volumeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 64));
        volumeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        volumeRow.Controls.Add(new Label { Text = "Volume", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 0);
        volumeRow.Controls.Add(_volume, 1, 0);
        AddRow(volumeRow, SizeType.Absolute, 34);

        // history
        _historyList.Columns.Add("When", 92);
        _historyList.Columns.Add("Party", 120);
        _historyList.Columns.Add("Result", 140);
        AddRow(_historyList, SizeType.Absolute, 130);

        // quick-dial buttons: the other extension and the other site
        var offices = new[] { ("Office", "1001"), ("Warehouse", "1002") };
        var others = offices.Where(o => o.Item2 != _ownExtension).ToArray();
        ConfigureQuick(_quickA, others.Length > 0 ? others[0] : default);
        ConfigureQuick(_quickB, others.Length > 1 ? others[1] : default);

        Controls.Add(root);
    }

    private void ConfigureQuick(Button b, (string name, string number) target)
    {
        if (string.IsNullOrEmpty(target.number)) { b.Visible = false; return; }
        b.Text = $"{target.name} ({target.number})";
        b.Tag = target.number;
    }

    private void WireEvents()
    {
        _call.Click += async (_, _) => await DialAsync(_number.Text);
        _answer.Click += async (_, _) => await _client.AnswerAsync();
        _hangup.Click += (_, _) => _client.Hangup();
        _mute.Click += (_, _) => _client.SetMute(_client.CurrentCall?.Muted != true);
        _hold.Click += async (_, _) => await _client.SetHoldAsync(_client.CurrentCall?.OnHold != true);
        _echo.Click += async (_, _) => await DialAsync("600");
        foreach (var q in new[] { _quickA, _quickB }) q.Click += async (_, _) => { if (q.Tag is string n) await DialAsync(n); };
        _volume.ValueChanged += (_, _) => { _settings.Volume = _volume.Value; _audio.SetVolume(_volume.Value); };
        _volume.MouseUp += (_, _) => SaveSettingsQuietly();
        _historyList.DoubleClick += async (_, _) =>
        {
            if (_historyList.SelectedItems.Count == 1 && _historyList.SelectedItems[0].Tag is string party && DialValidator.TryNormalize(party, out _))
                await DialAsync(party);
        };
        _number.KeyPress += (_, e) =>
        {
            if (e.KeyChar == (char)Keys.Enter) { e.Handled = true; _ = DialAsync(_number.Text); return; }
            if (char.IsControl(e.KeyChar)) return;
            if (!(char.IsDigit(e.KeyChar) || e.KeyChar is '*' or '#' or '+' or ' ' or '-')) e.Handled = true;
        };
        _tick.Tick += (_, _) => UpdateTimer();
        _tick.Start();
        Shown += (_, _) => OnFirstShown();
        FormClosing += OnClosing;
    }

    // ------------------------------------------------------------------ behaviour

    private void OnFirstShown()
    {
        if (_settings.Validate() is not null)
        {
            OpenSettings();
            return;
        }
        StartClient();
    }

    private void StartClient()
    {
        try { _client.Start(_settings); }
        catch (Exception ex) { ShowNotice(ex.Message, 12); }
    }

    private void OpenSettings()
    {
        if (_client.CurrentCall is not null) { ShowNotice("Finish the call before changing settings.", 5); return; }
        using var dialog = new SettingsForm(_settings);
        if (dialog.ShowDialog(this) != DialogResult.OK) { RefreshUi(); return; }
        _settings = dialog.Result;
        _volume.Value = Math.Clamp(_settings.Volume, 0, 100);
        SaveSettingsQuietly();
        StartClient();
        RefreshUi();
    }

    private void SaveSettingsQuietly()
    {
        try { _store.Save(_settings); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
        { ShowNotice("Could not save settings: " + ex.Message, 8); }
    }

    private void OpenLog()
    {
        if (_logForm is { IsDisposed: false }) { _logForm.Activate(); return; }
        string text; lock (_log) text = _log.ToString();
        _logForm = new LogForm(text);
        _logForm.Show(this);
    }

    private void AppendLog(string line)
    {
        string stamped = $"[{DateTime.Now:HH:mm:ss.fff}] {line}";
        lock (_log)
        {
            _log.AppendLine(stamped);
            if (_log.Length > 300_000) _log.Remove(0, _log.Length - 200_000);
        }
        Ui(() => _logForm?.Append(stamped));
    }

    private async Task DialAsync(string input)
    {
        var error = await _client.DialAsync(input);
        if (error is not null) ShowNotice(error, 6);
        else _notice = "";
        RefreshUi();
    }

    private void PressKey(char key)
    {
        if (_client.CurrentCall is { State: CallState.Connected })
        {
            _ = _client.SendDtmfAsync(key);
            return;
        }
        if (_client.CurrentCall is not null) return;
        _number.Text += key;
        _number.SelectionStart = _number.TextLength;
        _number.Focus();
    }

    protected override void OnKeyPress(KeyPressEventArgs e)
    {
        // During a call the keyboard is the dial pad (DTMF).
        if (_client.CurrentCall is { State: CallState.Connected } && (char.IsDigit(e.KeyChar) || e.KeyChar is '*' or '#'))
        {
            _ = _client.SendDtmfAsync(e.KeyChar);
            e.Handled = true;
        }
        base.OnKeyPress(e);
    }

    private void OnIncoming(CallInfo call)
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        FlashWindow();
        RefreshUi();
    }

    private void OnCallEnded(CallEndInfo end)
    {
        var call = end.Call;
        string result = end.Answered ? $"{(call.Incoming ? "Incoming" : "Outgoing")}, {FormatDuration(end.Duration)}"
            : call.Incoming ? "Missed / declined" : "Not connected";
        _history.Add(new SettingsStore.HistoryEntry(DateTime.Now, call.Incoming, call.IsPage ? $"Page: {call.PageGroup}" : call.Remote, end.Answered, end.Duration.TotalSeconds, result));
        _store.SaveHistory(_history);
        FillHistory();
        if (!end.Answered || end.Reason.StartsWith("The other party", StringComparison.Ordinal) || end.Reason.StartsWith("Missed", StringComparison.Ordinal))
            ShowNotice(end.Reason, 8);
        RefreshUi();
    }

    private void FillHistory()
    {
        _historyList.BeginUpdate();
        _historyList.Items.Clear();
        foreach (var e in Enumerable.Reverse(_history).Take(30))
        {
            var item = new ListViewItem(e.TimeLocal.Date == DateTime.Today ? e.TimeLocal.ToString("HH:mm") : e.TimeLocal.ToString("dd MMM HH:mm"));
            item.SubItems.Add((e.Incoming ? "← " : "→ ") + e.Party);
            item.SubItems.Add(e.Result);
            item.Tag = e.Party.StartsWith("Page", StringComparison.Ordinal) ? null : e.Party;
            if (!e.Answered) item.ForeColor = Color.Firebrick;
            _historyList.Items.Add(item);
        }
        _historyList.EndUpdate();
    }

    private void ShowNotice(string message, int seconds)
    {
        _notice = message;
        _noticeUntil = DateTime.UtcNow.AddSeconds(seconds);
        _noticeLabel.Text = message;
    }

    private void UpdateTimer()
    {
        var call = _client.CurrentCall;
        _timer.Text = call?.AnsweredUtc is { } answered ? FormatDuration(DateTime.UtcNow - answered) : "";
        if (_notice.Length > 0 && DateTime.UtcNow > _noticeUntil) { _notice = ""; RefreshUi(); }
    }

    private static string FormatDuration(TimeSpan t) => t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"m\:ss");

    private void RefreshUi()
    {
        var reg = _client.Registration;
        _dot.ForeColor = reg switch { RegistrationState.Registered => Green, RegistrationState.Registering => Amber, RegistrationState.Failed => Red, _ => Grey };
        _regText.Text = reg == RegistrationState.Stopped && _settings.Validate() is not null
            ? "Not set up. Open Settings."
            : _client.RegistrationDetail;

        var call = _client.CurrentCall;
        bool registered = reg == RegistrationState.Registered;
        bool idle = call is null;

        _number.Enabled = idle;
        _call.Visible = !(call is { State: CallState.Incoming });
        _call.Enabled = idle && registered;
        _answer.Visible = call is { State: CallState.Incoming };
        _hangup.Enabled = !idle;
        _hangup.Text = call?.State switch
        {
            CallState.Incoming => "Decline",
            CallState.Dialing or CallState.Ringing => "Cancel",
            CallState.Connected when call.IsPage => "Stop listening",
            _ => "Hang up",
        };
        bool connected = call is { State: CallState.Connected };
        _mute.Enabled = connected && !call!.IsPage;
        _hold.Enabled = connected && !call!.IsPage;
        _mute.Text = call?.Muted == true && !call.IsPage ? "Unmute" : "Mute";
        _hold.Text = call?.OnHold == true ? "Resume" : "Hold";
        _echo.Enabled = idle && registered;
        _quickA.Enabled = idle && registered;
        _quickB.Enabled = idle && registered;

        // Flat coloured buttons keep their colour when disabled, which looks clickable: grey them out instead.
        _call.BackColor = _call.Enabled ? Green : Color.Silver;
        _answer.BackColor = _answer.Enabled ? Green : Color.Silver;
        _hangup.BackColor = _hangup.Enabled ? Red : Color.Silver;

        _remote.Text = call?.Display ?? "";
        _timer.Text = call?.AnsweredUtc is { } a ? FormatDuration(DateTime.UtcNow - a) : "";
        _noticeLabel.Text = _notice.Length > 0 ? _notice : call is null && reg == RegistrationState.Failed ? _client.RegistrationDetail : "";
        _tooltip.SetToolTip(_regText, _client.RegistrationDetail);

        if (call is null)
        {
            _state.Text = registered ? "Ready" : reg == RegistrationState.Registering ? "Connecting…" : "Not connected";
            _state.ForeColor = registered ? Green : reg == RegistrationState.Registering ? Amber : Red;
        }
        else
        {
            (_state.Text, _state.ForeColor) = call.State switch
            {
                CallState.Dialing => ("Calling…", Amber),
                CallState.Ringing => ("Ringing…", Amber),
                CallState.Incoming => ("Incoming call", Amber),
                _ when call.IsPage => ("PAGE · listen only", Amber),
                _ when call.OnHold => ("On hold", Amber),
                _ => ("In call", Green),
            };
        }
    }

    private void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (_client.CurrentCall is { State: CallState.Connected } &&
            MessageBox.Show(this, "A call is in progress. End it and close the phone?", "SIP Phone", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
        {
            e.Cancel = true;
            return;
        }
        _tick.Stop();
        try { _client.Stop(); } catch { }
        _audio.Dispose();
        SaveSettingsQuietly();
    }

    private void Ui(Action action)
    {
        if (IsDisposed || Disposing) return;
        try
        {
            if (InvokeRequired) BeginInvoke(action); else action();
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    // ------------------------------------------------------------------ taskbar flash on incoming calls

    [StructLayout(LayoutKind.Sequential)]
    private struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }

    [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    private void FlashWindow()
    {
        var info = new FLASHWINFO { cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(), hwnd = Handle, dwFlags = 0x3 | 0xC, uCount = 8, dwTimeout = 0 };
        FlashWindowEx(ref info);
    }
}
