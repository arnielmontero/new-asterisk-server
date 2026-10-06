using System.Text;

namespace SipPhone;

/// <summary>Live SIP message log for troubleshooting (what the phone sent to and received from the PBX).</summary>
public sealed class LogForm : Form
{
    private readonly TextBox _text = new()
    {
        Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false,
        Dock = DockStyle.Fill, Font = new Font("Consolas", 9f), BackColor = Color.White,
    };

    public LogForm(string existing)
    {
        Text = "SIP log";
        StartPosition = FormStartPosition.CenterParent;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(760, 480);

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(8, 6, 8, 0) };
        var copy = new Button { Text = "Copy", AutoSize = true };
        var save = new Button { Text = "Save…", AutoSize = true };
        var clear = new Button { Text = "Clear", AutoSize = true };
        bar.Controls.AddRange(new Control[] { copy, save, clear });
        Controls.Add(_text);
        Controls.Add(bar);

        _text.Text = existing;
        _text.SelectionStart = _text.TextLength;
        _text.ScrollToCaret();

        copy.Click += (_, _) => { if (_text.TextLength > 0) Clipboard.SetText(_text.Text); };
        clear.Click += (_, _) => _text.Clear();
        save.Click += (_, _) =>
        {
            using var dialog = new SaveFileDialog { FileName = $"sip-log-{DateTime.Now:yyyyMMdd-HHmmss}.txt", Filter = "Text file|*.txt" };
            if (dialog.ShowDialog(this) == DialogResult.OK) File.WriteAllText(dialog.FileName, _text.Text, Encoding.UTF8);
        };
    }

    public void Append(string line)
    {
        if (IsDisposed) return;
        _text.AppendText(line + Environment.NewLine);
    }
}
