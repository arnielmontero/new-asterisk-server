// End-to-end self-test of the phone engine against a real PBX, with synthetic tones instead of a sound card.
// It runs two phones (1001-phone, 1002-phone) and checks registration, echo, two-way audio, ringing without
// auto-answer, decline, invalid numbers, DTMF, hold and (through the real backend API) one-way paging.
//
// Environment: PBX_HOST, PBX_PORT, PHONE1_USER/PHONE1_PASS, PHONE2_USER/PHONE2_PASS,
//              API_HOST (name used by the backend certificate), API_ADDR (where to connect), API_CA (CA pem),
//              ADMIN_USER, ADMIN_PASS (all optional: without the API settings the paging scenario is skipped).
using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using SipPhone.Core;

string Env(string name, string fallback = "") => Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : fallback;

var host = Env("PBX_HOST", "127.0.0.1");
var port = int.Parse(Env("PBX_PORT", "5060"));
var p1 = new PhoneSettings { Server = host, Port = port, Username = Env("PHONE1_USER", "1001-phone"), Password = Env("PHONE1_PASS"), DisplayName = "Office" };
var p2 = new PhoneSettings { Server = host, Port = port, Username = Env("PHONE2_USER", "1002-phone"), Password = Env("PHONE2_PASS"), DisplayName = "Warehouse" };
bool verbose = args.Contains("-v");

int passed = 0, failed = 0, skipped = 0;
void Check(string name, bool ok, string? detail = "")
{
    if (ok) { passed++; Console.WriteLine($"  PASS  {name}"); }
    else { failed++; Console.WriteLine($"  FAIL  {name}{(detail is { Length: > 0 } ? "  -> " + detail : "")}"); }
}
void Skip(string name, string why) { skipped++; Console.WriteLine($"  SKIP  {name}  ({why})"); }
void Section(string title) => Console.WriteLine($"\n== {title}");

async Task<bool> WaitFor(Func<bool> condition, int ms = 8000)
{
    var sw = Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < ms) { if (condition()) return true; await Task.Delay(50); }
    return condition();
}

// ---------------------------------------------------------------- scenarios
Console.WriteLine($"SIP phone self-test against {host}:{port}");
if (string.IsNullOrEmpty(p1.Password) || string.IsNullOrEmpty(p2.Password)) { Console.WriteLine("PHONE1_PASS / PHONE2_PASS are required."); return 2; }

var a = new Probe("A", 440, verbose);   // 1001-phone sends 440 Hz
var b = new Probe("B", 880, verbose);   // 1002-phone sends 880 Hz

try
{
    Section("Registration");
    var bad = new Probe("bad", 300, verbose);
    var badSettings = p1.Clone(); badSettings.Password = "definitely-wrong-password";
    bad.Client.Start(badSettings);
    Check("a wrong password is refused with a clear reason",
        await WaitFor(() => bad.Client.Registration == RegistrationState.Failed, 15000) && bad.Client.RegistrationDetail.Contains("refused", StringComparison.OrdinalIgnoreCase),
        $"{bad.Client.Registration}: {bad.Client.RegistrationDetail}");
    bad.Client.Stop();

    var unreachable = new Probe("unreachable", 300, verbose);
    var downSettings = p1.Clone(); downSettings.Port = 5999;
    unreachable.Client.Start(downSettings);
    Check("an unreachable server is reported, not hidden",
        await WaitFor(() => unreachable.Client.Registration == RegistrationState.Failed, 30000) && unreachable.Client.RegistrationDetail.Contains("No answer", StringComparison.OrdinalIgnoreCase),
        $"{unreachable.Client.Registration}: {unreachable.Client.RegistrationDetail}");
    unreachable.Client.Stop();

    a.Client.Start(p1); b.Client.Start(p2);
    Check("1001-phone registers", await WaitFor(() => a.Client.Registration == RegistrationState.Registered, 15000), a.Client.RegistrationDetail);
    Check("1002-phone registers", await WaitFor(() => b.Client.Registration == RegistrationState.Registered, 15000), b.Client.RegistrationDetail);
    if (a.Client.Registration != RegistrationState.Registered || b.Client.Registration != RegistrationState.Registered) throw new Exception("Cannot continue without registration.");

    // The PBX qualifies contacts every 30 s with OPTIONS; staying registered past that proves we answer it.
    if (Env("QUICK") != "1")
    {
        Console.WriteLine("  ...waiting 35 s so the PBX sends at least one OPTIONS keep-alive");
        await Task.Delay(35000);
    }
    Check("still registered after the PBX's OPTIONS keep-alive", a.Client.Registration == RegistrationState.Registered && b.Client.Registration == RegistrationState.Registered);

    Section("Echo test (600)");
    Check("dial 600 accepted", await a.Client.DialAsync("600") is null);
    Check("600 answers", await WaitFor(() => a.Client.CurrentCall?.State == CallState.Connected));
    await Task.Delay(2500);
    var echo = a.Audio.LastAudio!;
    Check("hears its own 440 Hz tone back", echo.Hears(440), $"440={echo.Share(440):P0} sent={echo.Source.PacketsSent} received={echo.Sink.PacketsReceived} frames={echo.Sink.FramesReceived}");
    Check("hears nothing else (no 880 Hz)", !echo.Hears(880), $"880={echo.Share(880):P0}");
    await a.Client.SendDtmfAsync('5');
    a.Client.Hangup();
    Check("hang-up returns to idle", await WaitFor(() => a.Client.CurrentCall is null) && a.LastEnded?.Answered == true);

    if (Env("STOP_AFTER") == "echo") goto finish;

    Section("Call 1001-phone -> 1002-phone");
    int bIncoming = b.IncomingCount;
    Check("dial 1002 accepted", await a.Client.DialAsync("1002") is null);
    Check("1002-phone rings", await WaitFor(() => b.IncomingCount > bIncoming));
    Check("caller hears ringback", await WaitFor(() => a.Audio.ToneCount(ToneKind.Ringback) > 0, 3000));
    Check("1002-phone plays its ring tone", b.Audio.ToneCount(ToneKind.Ring) > 0);
    await Task.Delay(3500);
    Check("an ordinary call is NOT auto-answered", b.Client.CurrentCall?.State == CallState.Incoming && b.Client.CurrentCall?.IsPage == false,
        $"state={b.Client.CurrentCall?.State}");
    await b.Client.AnswerAsync();
    Check("answered: both sides connected", await WaitFor(() => a.Client.CurrentCall?.State == CallState.Connected && b.Client.CurrentCall?.State == CallState.Connected));
    await Task.Delay(3000);
    var heardByA = a.Audio.LastAudio!; var heardByB = b.Audio.LastAudio!;
    Check("1001-phone hears 880 Hz (1002's voice)", heardByA.Hears(880), $"880={heardByA.Share(880):P0}");
    Check("1001-phone does not hear its own tone", !heardByA.Hears(440), $"440={heardByA.Share(440):P0}");
    Check("1002-phone hears 440 Hz (1001's voice)", heardByB.Hears(440), $"440={heardByB.Share(440):P0}");
    Check("1002-phone does not hear its own tone", !heardByB.Hears(880), $"880={heardByB.Share(880):P0}");
    Check("caller is shown as the other extension", b.Client.CurrentCall?.Remote == "1001", b.Client.CurrentCall?.Remote);

    await a.Client.SendDtmfAsync('1'); await a.Client.SendDtmfAsync('#');
    Check("DTMF sent without breaking the call", a.Client.CurrentCall?.State == CallState.Connected);

    a.Client.SetMute(true);
    await Task.Delay(1500);
    heardByB.Reset();
    await Task.Delay(1500);
    Check("mute: the other side stops hearing 440 Hz", !b.Audio.LastAudio!.Hears(440), $"440={b.Audio.LastAudio.Share(440):P0}");
    a.Client.SetMute(false);
    b.Audio.LastAudio!.Reset();
    await Task.Delay(2000);
    Check("unmute: 440 Hz is heard again", b.Audio.LastAudio.Hears(440), $"440={b.Audio.LastAudio.Share(440):P0}");

    await a.Client.SetHoldAsync(true);
    Check("hold accepted by the PBX (call still up)", a.Client.CurrentCall?.OnHold == true && await WaitFor(() => a.Client.CurrentCall?.State == CallState.Connected, 2000));
    await Task.Delay(1500);
    await a.Client.SetHoldAsync(false);
    await Task.Delay(1500);
    Check("resume after hold: call still up", a.Client.CurrentCall?.State == CallState.Connected && b.Client.CurrentCall?.State == CallState.Connected);

    int aEnded = a.EndedCount;
    b.Client.Hangup();
    Check("remote hang-up ends the other side", await WaitFor(() => a.EndedCount > aEnded && a.Client.CurrentCall is null));
    Check("the end reason says the other party hung up", a.LastEnded?.Reason.Contains("hung up", StringComparison.OrdinalIgnoreCase) == true, a.LastEnded?.Reason);
    Check("call duration is recorded", a.LastEnded?.Duration > TimeSpan.FromSeconds(5), a.LastEnded?.Duration.ToString());

    Section("Decline, cancel, invalid number, busy");
    bIncoming = b.IncomingCount; int bEnded = b.EndedCount; aEnded = a.EndedCount;
    await a.Client.DialAsync("1002");
    await WaitFor(() => b.IncomingCount > bIncoming);
    b.Client.Reject();
    Check("declined call is reported to the caller", await WaitFor(() => a.EndedCount > aEnded) && a.LastEnded?.Answered == false, a.LastEnded?.Reason);
    Console.WriteLine($"        caller was told: \"{a.LastEnded?.Reason}\"");

    bIncoming = b.IncomingCount; bEnded = b.EndedCount; aEnded = a.EndedCount;
    await a.Client.DialAsync("1002");
    await WaitFor(() => b.IncomingCount > bIncoming);
    a.Client.Hangup();
    Check("caller cancelling stops the ringing on the callee", await WaitFor(() => b.EndedCount > bEnded && b.Client.CurrentCall is null), b.LastEnded?.Reason);
    Check("callee sees a missed call", b.LastEnded?.Reason.Contains("Missed", StringComparison.OrdinalIgnoreCase) == true, b.LastEnded?.Reason);

    aEnded = a.EndedCount;
    await a.Client.DialAsync("999");
    Check("an invalid number is rejected with a reason", await WaitFor(() => a.EndedCount > aEnded) && a.LastEnded?.Answered == false, a.LastEnded?.Reason);
    Console.WriteLine($"        caller was told: \"{a.LastEnded?.Reason}\"");
    Check("typing garbage is refused before anything is sent", await a.Client.DialAsync("12abc") is not null);
    Check("empty number is refused", await a.Client.DialAsync("  ") is not null);

    aEnded = a.EndedCount; bEnded = b.EndedCount;
    await a.Client.DialAsync("600");
    await WaitFor(() => a.Client.CurrentCall?.State == CallState.Connected);
    Check("a second call while one is active is refused", await a.Client.DialAsync("1002") is not null);
    a.Client.Hangup();
    await WaitFor(() => a.Client.CurrentCall is null);

    Section("Direct paging from a phone is refused by the PBX");
    aEnded = a.EndedCount;
    await a.Client.DialAsync("701");
    Check("700-702 dialled without a backend grant fails", await WaitFor(() => a.EndedCount > aEnded) && a.LastEnded?.Answered == false, a.LastEnded?.Reason);

    // ------------------------------------------------------------ paging through the backend
    Section("One-way paging (through the real backend)");
    var apiAddr = Env("API_ADDR"); var apiHost = Env("API_HOST", "communications.local");
    var adminUser = Env("ADMIN_USER", "admin"); var adminPass = Env("ADMIN_PASS");
    if (apiAddr.Length == 0 || adminPass.Length == 0) Skip("paging scenario", "API_ADDR / ADMIN_PASS not set");
    else
    {
        using var api = new ApiClient(apiAddr, apiHost, Env("API_CA"));
        var opName = "selftest.operator"; var opPass = "SelfTest-" + Guid.NewGuid().ToString("N")[..16] + "!";
        await api.LoginAsync(adminUser, adminPass);
        await api.DeleteUserIfExistsAsync(opName);
        var opId = await api.CreateUserAsync(opName, opPass, "operator", "1002");
        try
        {
            await api.LoginAsync(opName, opPass);

            // 1002 (operator) pages "Office" (701): 1001-phone must answer by itself, listen-only.
            var grant = await api.PageAsync("701");
            Check("backend authorises the page", grant.ok, grant.body);
            int aIn = a.IncomingCount; aEnded = a.EndedCount;
            Check("operator's phone dials 701", await b.Client.DialAsync("701") is null);
            Check("1001-phone auto-answers the page", await WaitFor(() => a.Client.CurrentCall is { State: CallState.Connected, IsPage: true }, 10000),
                $"state={a.Client.CurrentCall?.State} isPage={a.Client.CurrentCall?.IsPage}");
            Check("page shown as 'Page: Office', not as a normal call", a.Client.CurrentCall?.Display == "Page: Office", a.Client.CurrentCall?.Display);
            Check("no ring tone was played for the page (auto-answered silently)", a.Audio.ToneCount(ToneKind.Ring) == 0, $"rings={a.Audio.ToneCount(ToneKind.Ring)}");
            await Task.Delay(3500);
            Check("recipient hears the operator (880 Hz)", a.Audio.LastAudio!.Hears(880), $"880={a.Audio.LastAudio.Share(880):P0}");
            Check("operator hears nothing back (one-way)", !b.Audio.LastAudio!.Hears(440) && !b.Audio.LastAudio.Hears(880),
                $"440={b.Audio.LastAudio.Share(440):P0} 880={b.Audio.LastAudio.Share(880):P0}");
            a.Client.SetMute(false);
            Check("the paged phone cannot be un-muted during a page", a.Client.CurrentCall?.Muted == true);
            b.Client.Hangup();
            Check("page ends for the recipient when the operator stops", await WaitFor(() => a.Client.CurrentCall is null, 10000));

            // The grant is single use: dialling again without a new request must fail.
            aEnded = b.EndedCount;
            await b.Client.DialAsync("701");
            Check("the page grant is single use", await WaitFor(() => b.EndedCount > aEnded) && b.LastEnded?.Answered == false, b.LastEnded?.Reason);

            // Wrong group for the grant.
            await api.PageAsync("701");
            aEnded = b.EndedCount;
            await b.Client.DialAsync("700");
            Check("a grant for 701 does not allow 700", await WaitFor(() => b.EndedCount > aEnded) && b.LastEnded?.Answered == false, b.LastEnded?.Reason);
            await api.CancelPageAsync();
        }
        finally
        {
            await api.LoginAsync(adminUser, adminPass);
            await api.DeleteUserAsync(opId);
        }
    }
}
catch (Exception ex)
{
    failed++;
    Console.WriteLine($"  FAIL  aborted: {ex.Message}");
    Console.WriteLine("---- phone A trace ----\n" + a.RecentTrace());
}
finally
{
    a.Client.Stop(); b.Client.Stop();
}

finish:
Console.WriteLine($"\n== Summary: {passed} passed, {failed} failed, {skipped} skipped");
return failed == 0 ? 0 : 1;

// ---------------------------------------------------------------- one phone under test
sealed class Probe
{
    public readonly string Name;
    public readonly ToneAudioFactory Audio;
    public readonly SipPhoneClient Client;
    public readonly List<CallEndInfo> Ended = new();
    public readonly List<CallInfo> Incoming = new();
    public readonly List<string> Log = new();
    public volatile CallInfo? Last;

    public Probe(string name, double toneHz, bool verbose)
    {
        Name = name;
        Audio = new ToneAudioFactory(toneHz);
        Client = new SipPhoneClient(Audio);
        Client.CallEnded += e => { lock (Ended) Ended.Add(e); };
        Client.IncomingCall += c => { lock (Incoming) Incoming.Add(c); };
        Client.CallStateChanged += c => Last = c;
        Client.Trace += t => { lock (Log) { Log.Add(t); if (Log.Count > 400) Log.RemoveAt(0); } if (verbose) Console.WriteLine($"[{name}] {t}"); };
    }
    public int EndedCount { get { lock (Ended) return Ended.Count; } }
    public CallEndInfo? LastEnded { get { lock (Ended) return Ended.LastOrDefault(); } }
    public int IncomingCount { get { lock (Incoming) return Incoming.Count; } }
    public string RecentTrace() { lock (Log) return string.Join("\n", Log.TakeLast(40)); }
}

// ---------------------------------------------------------------- synthetic audio
sealed class ToneAudioFactory : ICallAudioFactory
{
    private readonly double _hz;
    private readonly Dictionary<ToneKind, int> _tones = new();
    public ToneCallAudio? LastAudio { get; private set; }
    public ToneAudioFactory(double hz) => _hz = hz;
    public ICallAudio Create() => LastAudio = new ToneCallAudio(_hz);
    public void StartTone(ToneKind kind) { lock (_tones) _tones[kind] = _tones.GetValueOrDefault(kind) + 1; }
    public void StopTone() { }
    public int ToneCount(ToneKind kind) { lock (_tones) return _tones.GetValueOrDefault(kind); }
}

sealed class ToneCallAudio : ICallAudio
{
    private readonly double _hz;
    private readonly Timer _timer;
    private double _phase;
    private readonly List<short> _received = new();
    private readonly object _lock = new();
    public PcmAudioSource Source { get; } = new();
    public PcmAudioSink Sink { get; } = new();

    public ToneCallAudio(double hz)
    {
        _hz = hz;
        Sink.PcmReceived += pcm => { lock (_lock) { _received.AddRange(pcm); if (_received.Count > 8000 * 2) _received.RemoveRange(0, _received.Count - 8000 * 2); } };
        // A real microphone delivers 20 ms every 20 ms; so does this.
        _timer = new Timer(_ => Tick(), null, Timeout.Infinite, Timeout.Infinite);
        Source.Started += () => _timer.Change(0, 20);
        Source.Stopped += () => _timer.Change(Timeout.Infinite, Timeout.Infinite);
    }

    private void Tick()
    {
        var frame = new short[PcmAudioSource.FrameSamples];
        for (int i = 0; i < frame.Length; i++)
        {
            frame[i] = (short)(Math.Sin(_phase) * 12000);
            _phase += 2 * Math.PI * _hz / PcmAudioSource.SampleRate;
        }
        Source.Push(frame);
    }

    public void Reset() { lock (_lock) _received.Clear(); }

    /// <summary>Share of the received signal power found at this frequency over the last 1.5 s (Goertzel).</summary>
    public double Share(double hz)
    {
        short[] samples;
        lock (_lock) samples = _received.TakeLast(12000).ToArray();
        if (samples.Length < 4000) return 0;
        double total = samples.Sum(s => (double)s * s) / samples.Length;
        if (total < 1e4) return 0; // silence
        double w = 2 * Math.PI * hz / PcmAudioSource.SampleRate, coeff = 2 * Math.Cos(w), s1 = 0, s2 = 0;
        foreach (var x in samples) { var s0 = x + coeff * s1 - s2; s2 = s1; s1 = s0; }
        double power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.Length / samples.Length * 2;
        return Math.Min(1.0, power / total);
    }

    public bool Hears(double hz) => Share(hz) > 0.5;
    public void Dispose() { _timer.Dispose(); Source.Dispose(); Sink.Dispose(); }
}

// ---------------------------------------------------------------- minimal backend API client
sealed class ApiClient : IDisposable
{
    private readonly HttpClient _http;

    public ApiClient(string address, string host, string caPath)
    {
        X509Certificate2? ca = caPath.Length > 0 && File.Exists(caPath) ? new X509Certificate2(caPath) : null;
        var handler = new SocketsHttpHandler
        {
            CookieContainer = new CookieContainer(),
            ConnectCallback = async (ctx, ct) =>
            {
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp);
                await socket.ConnectAsync(IPAddress.Parse(address), 443, ct);
                return new NetworkStream(socket, ownsSocket: true);
            },
            SslOptions = new SslClientAuthenticationOptions
            {
                TargetHost = host,
                RemoteCertificateValidationCallback = (_, cert, chain, errors) =>
                {
                    if (errors == SslPolicyErrors.None) return true;
                    if (ca is null || cert is null || chain is null) return false;
                    using var custom = new X509Chain();
                    custom.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                    custom.ChainPolicy.CustomTrustStore.Add(ca);
                    custom.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                    return custom.Build(new X509Certificate2(cert)) && (errors & ~SslPolicyErrors.RemoteCertificateChainErrors) == 0;
                },
            },
        };
        _http = new HttpClient(handler) { BaseAddress = new Uri($"https://{host}") };
    }

    public async Task LoginAsync(string user, string pass)
    {
        var r = await _http.PostAsJsonAsync("/api/auth/login", new { username = user, password = pass });
        if (!r.IsSuccessStatusCode) throw new Exception($"login as {user} failed: {(int)r.StatusCode} {await r.Content.ReadAsStringAsync()}");
    }

    public async Task<int> CreateUserAsync(string user, string pass, string role, string extension)
    {
        var r = await _http.PostAsJsonAsync("/api/users", new { username = user, password = pass, role, extension });
        var text = await r.Content.ReadAsStringAsync();
        if (!r.IsSuccessStatusCode) throw new Exception($"create user failed: {(int)r.StatusCode} {text}");
        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        if (root.TryGetProperty("user", out var u)) root = u;
        var id = root.GetProperty("id");
        return id.ValueKind == JsonValueKind.Number ? id.GetInt32() : int.Parse(id.GetString()!);
    }

    public async Task DeleteUserIfExistsAsync(string user)
    {
        var list = await _http.GetStringAsync("/api/users");
        using var doc = JsonDocument.Parse(list);
        var arr = doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement : doc.RootElement.GetProperty("users");
        foreach (var u in arr.EnumerateArray())
            if (u.GetProperty("username").GetString() == user) { var uid = u.GetProperty("id"); await DeleteUserAsync(uid.ValueKind == JsonValueKind.Number ? uid.GetInt32() : int.Parse(uid.GetString()!)); }
    }

    public async Task DeleteUserAsync(int id) => await _http.DeleteAsync($"/api/users/{id}");

    public async Task<(bool ok, string body)> PageAsync(string group)
    {
        var r = await _http.PostAsJsonAsync("/api/page", new { group });
        return (r.IsSuccessStatusCode, $"{(int)r.StatusCode} {await r.Content.ReadAsStringAsync()}");
    }

    public async Task CancelPageAsync() => await _http.DeleteAsync("/api/page");
    public void Dispose() => _http.Dispose();
}
