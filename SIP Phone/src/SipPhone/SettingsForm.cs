using SipPhone.Core;

namespace SipPhone;

/// <summary>Account and audio settings. Values come from the administrator: DEPLOYMENT.md section 9.</summary>
public sealed class SettingsForm : Form
{
    private readonly TextBox _server = new() { Dock = DockStyle.Fill };
    private readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535, Value = 5060, Width = 90 };
    private readonly TextBox _user = new() { Dock = DockStyle.Fill };
    private readonly TextBox _password = new() { Dock = DockStyle.Fill, UseSystemPasswordChar = true };
    private readonly CheckBox _show = new() { Text = "Show password", AutoSize = true };
    private readonly TextBox _display = new() { Dock = DockStyle.Fill };
    private readonly CheckBox _autoAnswer = new() { Text = "Answer paging calls automatically (listen only)", AutoSize = true, Checked = true };
    private readonly ComboBox _mic = new() { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly ComboBox _speaker = new() { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly Label _error = new() { AutoSize = true, ForeColor = Color.Firebrick, MaximumSize = new Size(420, 0) };
    private readonly PhoneSettings _original;

    public PhoneSettings Result { get; private set; }

    public SettingsForm(PhoneSettings current)
    {
        _original = current.Clone();
        Result = current.Clone();
        Text = "SIP Phone settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.5f);
        ClientSize = new Size(480, 470);

        var help = new Label
        {
            Text = "Enter the details your administrator gave you for this phone: the server address, the SIP user (for example 1001-phone) and its password.",
            AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = SystemColors.GrayText,
        };

        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true, Padding = new Padding(16, 12, 16, 8) };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        void Row(string label, Control control)
        {
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 8, 8, 8) });
            control.Margin = new Padding(0, 4, 0, 4);
            grid.Controls.Add(control);
        }
        void Span(Control control)
        {
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(control);
            grid.SetColumnSpan(control, 2);
            control.Margin = new Padding(0, 4, 0, 4);
        }

        Span(help);
        Row("Server address", _server);
        Row("Port (UDP)", _port);
        Row("SIP user", _user);
        Row("Password", _password);
        Span(_show);
        Row("Display name", _display);
        Span(_autoAnswer);
        Row("Microphone", _mic);
        Row("Speaker", _speaker);

        var test = new Button { Text = "Play test sound", AutoSize = true };
        test.Click += (_, _) =>
        {
            try { WindowsAudioFactory.PlayTestTone(SelectedName(_speaker), _original.Volume); }
            catch (Exception ex) { _error.Text = "Cannot play on that speaker: " + ex.Message; }
        };
        Span(test);
        Span(_error);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 52, Padding = new Padding(12, 8, 12, 8) };
        var save = new Button { Text = "Save and connect", AutoSize = true, DialogResult = DialogResult.None, Padding = new Padding(8, 2, 8, 2) };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel, Padding = new Padding(8, 2, 8, 2) };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(save);
        AcceptButton = save; CancelButton = cancel;
        save.Click += (_, _) => TrySave();

        Controls.Add(grid);
        Controls.Add(buttons);

        _show.CheckedChanged += (_, _) => _password.UseSystemPasswordChar = !_show.Checked;

        _mic.Items.Add("System default");
        foreach (var d in AudioDevices.Inputs()) _mic.Items.Add(d);
        _speaker.Items.Add("System default");
        foreach (var d in AudioDevices.Outputs()) _speaker.Items.Add(d);

        _server.Text = current.Server;
        _port.Value = Math.Clamp(current.Port, 1, 65535);
        _user.Text = current.Username;
        _password.Text = current.Password;
        _display.Text = current.DisplayName;
        _autoAnswer.Checked = current.AutoAnswerPages;
        Select(_mic, current.InputDevice);
        Select(_speaker, current.OutputDevice);
    }

    private static void Select(ComboBox box, string name)
    {
        int i = string.IsNullOrEmpty(name) ? 0 : box.Items.IndexOf(name);
        box.SelectedIndex = i < 0 ? 0 : i;
    }

    private static string SelectedName(ComboBox box) => box.SelectedIndex <= 0 ? "" : (string)box.SelectedItem!;

    private void TrySave()
    {
        var s = _original.Clone();
        s.Server = _server.Text.Trim();
        s.Port = (int)_port.Value;
        s.Username = _user.Text.Trim();
        s.Password = _password.Text;
        s.DisplayName = _display.Text.Trim();
        s.AutoAnswerPages = _autoAnswer.Checked;
        s.InputDevice = SelectedName(_mic);
        s.OutputDevice = SelectedName(_speaker);

        var problem = s.Validate();
        if (problem is not null) { _error.Text = problem; return; }
        Result = s;
        DialogResult = DialogResult.OK;
        Close();
    }
}
