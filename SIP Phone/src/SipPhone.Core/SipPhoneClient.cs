using System.Net;
using System.Net.Sockets;
using SIPSorcery.Media;
using SIPSorcery.Net;
using SIPSorcery.SIP;
using SIPSorcery.SIP.App;
using SIPSorceryMedia.Abstractions;

namespace SipPhone.Core;

public enum RegistrationState { Stopped, Registering, Registered, Failed }

public enum CallState { Idle, Dialing, Ringing, Incoming, Connected }

public sealed class CallInfo
{
    public string Remote { get; init; } = "";
    public string RemoteName { get; init; } = "";
    public bool Incoming { get; init; }
    /// <summary>True for a page (700/701/702 with the paging markers): listen-only, auto-answered.</summary>
    public bool IsPage { get; init; }
    public string PageGroup { get; init; } = "";
    public DateTime StartedUtc { get; init; } = DateTime.UtcNow;
    public DateTime? AnsweredUtc { get; set; }
    public CallState State { get; set; }
    public bool Muted { get; set; }
    public bool OnHold { get; set; }
    public string Display => IsPage ? $"Page: {PageGroup}"
        : string.IsNullOrWhiteSpace(RemoteName) || RemoteName == Remote ? Remote : $"{RemoteName} ({Remote})";
}

public sealed record CallEndInfo(CallInfo Call, string Reason, TimeSpan Duration, bool Answered);

/// <summary>
/// A SIP/UDP phone that behaves like the physical phone profile in DEPLOYMENT.md section 9: REGISTER with digest
/// authentication, answers the PBX's OPTIONS keep-alive, G.711 audio, RFC 4733 DTMF, one call at a time,
/// auto-answer for the PBX's paging calls (listen-only).
/// </summary>
public sealed class SipPhoneClient : IDisposable
{
    public const string UserAgentName = "LAN-Comms-SIPPhone/1.0";

    private readonly ICallAudioFactory _audio;
    private readonly object _gate = new();
    private PhoneSettings _settings = new();
    private SIPTransport? _transport;
    private SIPUserAgent? _ua;
    private SIPRegistrationUserAgent? _reg;
    private IPAddress[] _serverAddresses = Array.Empty<IPAddress>();
    private Timer? _retryTimer;
    private int _retryCount;
    private int _generation; // bumped on every Start/Stop so late callbacks from an old agent are ignored

    private CallInfo? _call;
    private SIPServerUserAgent? _pendingUas;
    private ICallAudio? _callAudio;
    private VoIPMediaSession? _session;

    public RegistrationState Registration { get; private set; } = RegistrationState.Stopped;
    public string RegistrationDetail { get; private set; } = "Not started";
    public CallInfo? CurrentCall { get { lock (_gate) return _call; } }

    public event Action<RegistrationState, string>? RegistrationChanged;
    public event Action<CallInfo>? CallStateChanged;
    public event Action<CallInfo>? IncomingCall;
    public event Action<CallEndInfo>? CallEnded;
    public event Action<string>? Trace;

    public SipPhoneClient(ICallAudioFactory audio) => _audio = audio;

    // ------------------------------------------------------------------ start / stop

    public void Start(PhoneSettings settings)
    {
        var problem = settings.Validate();
        if (problem is not null) throw new ArgumentException(problem);
        Stop();

        _settings = settings.Clone();
        _settings.Server = _settings.Server.Trim();
        _settings.Username = _settings.Username.Trim();
        int generation = Interlocked.Increment(ref _generation);
        _retryCount = 0;
        SetRegistration(RegistrationState.Registering, $"Registering {_settings.Username} at {_settings.Server}…");

        try
        {
            ResolveServer();
            _transport = new SIPTransport();
            _transport.AddSIPChannel(new SIPUDPChannel(new IPEndPoint(IPAddress.Any, _settings.LocalSipPort)));
            _transport.SIPTransportRequestReceived += OnTransportRequest;
            _transport.SIPRequestInTraceEvent += (_, remote, req) => Trace?.Invoke($"<<< {remote}\n{req}");
            _transport.SIPRequestOutTraceEvent += (_, remote, req) => Trace?.Invoke($">>> {remote}\n{req}");
            _transport.SIPResponseInTraceEvent += (_, remote, resp) => Trace?.Invoke($"<<< {remote}\n{resp}");
            _transport.SIPResponseOutTraceEvent += (_, remote, resp) => Trace?.Invoke($">>> {remote}\n{resp}");

            _ua = new SIPUserAgent(_transport, null);
            _ua.OnIncomingCall += OnIncomingInvite;
            _ua.ClientCallTrying += (_, _) => Trace?.Invoke("[phone] call: trying");
            _ua.ClientCallRinging += (_, _) => { Trace?.Invoke("[phone] call: ringing"); OnOutgoingRinging(); };
            _ua.ClientCallAnswered += (_, _) => { Trace?.Invoke("[phone] call: answered"); OnOutgoingAnswered(); };
            _ua.ClientCallFailed += (_, error, resp) => EndCall(resp is not null
                ? CallFailureText.ForStatus((int)resp.Status, resp.ReasonPhrase)
                : $"The call failed: {error}");
            _ua.OnCallHungup += _ => EndCall("The other party hung up.");
            _ua.ServerCallCancelled += (_, _) => EndCall("Missed: the caller gave up.");
            _ua.RemotePutOnHold += () => Trace?.Invoke("Remote party put the call on hold.");
            _ua.RemoteTookOffHold += () => Trace?.Invoke("Remote party resumed the call.");

            StartRegistration(generation);
        }
        catch (Exception ex)
        {
            Trace?.Invoke($"Start failed: {ex}");
            SetRegistration(RegistrationState.Failed, ex is SocketException
                ? $"Cannot use the network: {ex.Message}"
                : ex.Message);
            ScheduleRetry(generation);
        }
    }

    public void Stop()
    {
        Interlocked.Increment(ref _generation);
        _retryTimer?.Dispose();
        _retryTimer = null;
        try { Hangup(); } catch { }
        try { EndCall("Phone stopped."); } catch { }
        try { _reg?.Stop(true); } catch { }
        try { _ua?.Close(); } catch { }
        try { _transport?.Shutdown(); } catch { }
        _reg = null; _ua = null; _transport = null;
        if (Registration != RegistrationState.Stopped) SetRegistration(RegistrationState.Stopped, "Not registered");
    }

    public void Dispose() => Stop();

    private void ResolveServer()
    {
        IPAddress[] addresses;
        try { addresses = Dns.GetHostAddresses(_settings.Server); }
        catch (SocketException) { throw new InvalidOperationException($"Cannot find the server \"{_settings.Server}\" (name lookup failed)."); }
        _serverAddresses = addresses.Where(a => a.AddressFamily == AddressFamily.InterNetwork).ToArray();
        if (_serverAddresses.Length == 0) throw new InvalidOperationException($"\"{_settings.Server}\" has no IPv4 address.");
    }

    // ------------------------------------------------------------------ registration

    private void StartRegistration(int generation)
    {
        var server = $"{_settings.Server}:{_settings.Port}";
        var reg = new SIPRegistrationUserAgent(_transport, _settings.Username, _settings.Password, server,
            _settings.RegisterExpirySeconds, maxRegistrationAttemptTimeout: 10, registerFailureRetryInterval: 10,
            maxRegisterAttempts: 3, exitOnUnequivocalFailure: true, sendUsernameInContactHeader: true);
        reg.RegistrationSuccessful += (_, _) =>
        {
            if (generation != _generation) return;
            _retryCount = 0;
            SetRegistration(RegistrationState.Registered, $"Registered as {_settings.Username} at {_settings.Server}");
        };
        reg.RegistrationFailed += (_, resp, err) =>
        {
            if (generation != _generation) return;
            SetRegistration(RegistrationState.Failed, RegistrationFailureText(resp, err));
            ScheduleRetry(generation, resp is not null && ((int)resp.Status is 401 or 403 or 407));
        };
        reg.RegistrationTemporaryFailure += (_, resp, err) =>
        {
            if (generation != _generation) return;
            SetRegistration(RegistrationState.Failed, RegistrationFailureText(resp, err));
            ScheduleRetry(generation);
        };
        _reg = reg;
        reg.Start();
    }

    private string RegistrationFailureText(SIPResponse? resp, string? err)
    {
        if (resp is not null)
        {
            int code = (int)resp.Status;
            if (code is 401 or 403 or 407) return $"The server refused the login for {_settings.Username}: check the SIP user and password (SIP {code}).";
            if (code == 404) return $"The server does not know the user {_settings.Username} (SIP 404).";
            return $"Registration failed: SIP {code} {resp.ReasonPhrase}";
        }
        return $"No answer from {_settings.Server}:{_settings.Port}. Check the address, the network and that this PC is inside the allowed LAN subnet. ({err})";
    }

    /// <summary>The registration agent gives up after a few attempts; a phone must keep trying, politely.</summary>
    private void ScheduleRetry(int generation, bool authFailure = false)
    {
        _retryTimer?.Dispose();
        int seconds = authFailure ? 300 : Math.Min(60, 5 * (1 << Math.Min(_retryCount, 4)));
        _retryCount++;
        _retryTimer = new Timer(_ =>
        {
            if (generation != _generation) return;
            try
            {
                try { _reg?.Stop(false); } catch { }
                _reg = null;
                if (_transport is null || _ua is null) { Start(_settings); return; }
                ResolveServer();
                SetRegistration(RegistrationState.Registering, $"Registering {_settings.Username} at {_settings.Server}…");
                StartRegistration(generation);
            }
            catch (Exception ex)
            {
                SetRegistration(RegistrationState.Failed, ex.Message);
                ScheduleRetry(generation);
            }
        }, null, TimeSpan.FromSeconds(seconds), Timeout.InfiniteTimeSpan);
    }

    private void SetRegistration(RegistrationState state, string detail)
    {
        Registration = state;
        RegistrationDetail = detail;
        RegistrationChanged?.Invoke(state, detail);
    }

    /// <summary>The PBX qualifies every contact with OPTIONS (qualify_frequency = 30). Unanswered, Asterisk would mark us Unavailable and stop ringing us.</summary>
    private async Task OnTransportRequest(SIPEndPoint localEndPoint, SIPEndPoint remoteEndPoint, SIPRequest request)
    {
        if (request.Method != SIPMethodsEnum.OPTIONS || _transport is null) return;
        var ok = SIPResponse.GetResponse(request, SIPResponseStatusCodesEnum.Ok, null);
        ok.Header.Allow = "INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY";
        ok.Header.UserAgent = UserAgentName;
        await _transport.SendResponseAsync(ok);
    }

    // ------------------------------------------------------------------ outgoing calls

    /// <summary>Starts a call. Returns null when started, otherwise a message to show the user.</summary>
    public async Task<string?> DialAsync(string input)
    {
        if (!DialValidator.TryNormalize(input, out var number)) return "Enter a valid number: digits, * and # only.";
        if (Registration != RegistrationState.Registered || _ua is null) return "Not registered with the server yet.";

        CallInfo call;
        lock (_gate)
        {
            if (_call is not null) return "A call is already in progress.";
            call = new CallInfo { Remote = number, RemoteName = number, Incoming = false, State = CallState.Dialing };
            _call = call;
        }
        RaiseCallState(call);

        try
        {
            var media = CreateMedia();
            var uri = $"sip:{number}@{_settings.Server}:{_settings.Port}";
            var from = string.IsNullOrWhiteSpace(_settings.DisplayName)
                ? $"<sip:{_settings.Username}@{_settings.Server}>"
                : $"\"{_settings.DisplayName.Replace("\"", "")}\" <sip:{_settings.Username}@{_settings.Server}>";
            var descriptor = new SIPCallDescriptor(_settings.Username, _settings.Password, uri, from, null, null, null, null,
                SIPCallDirection.Out, SDP.SDP_MIME_CONTENTTYPE, null, null);
            _ = Task.Run(async () =>
            {
                try
                {
                    bool answered = await _ua!.Call(descriptor, media, 60);
                    if (!answered && CurrentCall == call) EndCall("The call was not answered.");
                }
                catch (Exception ex) { EndCall($"The call failed: {ex.Message}"); }
            });
            await Task.CompletedTask;
            return null;
        }
        catch (Exception ex)
        {
            EndCall($"The call failed: {ex.Message}");
            return ex.Message;
        }
    }

    private void OnOutgoingRinging()
    {
        CallInfo? call;
        lock (_gate) { call = _call; if (call is null || call.State != CallState.Dialing) return; call.State = CallState.Ringing; }
        _audio.StartTone(ToneKind.Ringback);
        RaiseCallState(call);
    }

    private void OnOutgoingAnswered()
    {
        CallInfo? call;
        lock (_gate) { call = _call; if (call is null) return; call.State = CallState.Connected; call.AnsweredUtc = DateTime.UtcNow; }
        _audio.StopTone();
        RaiseCallState(call);
    }

    // ------------------------------------------------------------------ incoming calls

    private async void OnIncomingInvite(SIPUserAgent ua, SIPRequest request)
    {
        SIPServerUserAgent? uas = null;
        try
        {
            uas = ua.AcceptCall(request);

            var remoteIp = request.RemoteSIPEndPoint?.Address;
            if (remoteIp is null || !_serverAddresses.Any(a => a.Equals(remoteIp)))
            {
                // Only the PBX may ring this phone. Anyone else on the LAN is refused.
                Trace?.Invoke($"Refused an INVITE from {remoteIp} (not the PBX).");
                uas.Reject(SIPResponseStatusCodesEnum.Forbidden, "Not from the PBX");
                return;
            }

            string user = request.Header.From?.FromURI?.User ?? "unknown";
            string name = (request.Header.From?.FromName ?? "").Trim('"', ' ');
            bool isPage = PagingDetect.IsPagingInvite(user,
                SipHeaders.Get(request, "X-Paging-Call"),
                SipHeaders.Get(request, "Call-Info"));

            CallInfo call;
            lock (_gate)
            {
                if (_call is not null)
                {
                    uas.Reject(SIPResponseStatusCodesEnum.BusyHere, "Busy");
                    return;
                }
                call = new CallInfo
                {
                    Remote = user, RemoteName = name, Incoming = true, IsPage = isPage,
                    PageGroup = isPage ? PagingDetect.GroupName(user) : "", State = CallState.Incoming, Muted = isPage,
                };
                _call = call;
                _pendingUas = uas;
            }

            uas.Progress(SIPResponseStatusCodesEnum.Ringing, null, null, null, null);
            RaiseCallState(call);

            if (isPage && _settings.AutoAnswerPages)
            {
                await AnswerAsync();
            }
            else
            {
                _audio.StartTone(ToneKind.Ring);
                IncomingCall?.Invoke(call);
            }
        }
        catch (Exception ex)
        {
            Trace?.Invoke($"Incoming call error: {ex}");
            try { uas?.Reject(SIPResponseStatusCodesEnum.InternalServerError, "Phone error"); } catch { }
            EndCall($"The incoming call failed: {ex.Message}");
        }
    }

    public async Task AnswerAsync()
    {
        CallInfo? call; SIPServerUserAgent? uas;
        lock (_gate) { call = _call; uas = _pendingUas; }
        if (call is null || uas is null || call.State != CallState.Incoming || _ua is null) return;

        _audio.StopTone();
        try
        {
            var media = CreateMedia();
            if (call.IsPage) _callAudio!.Source.Muted = true; // a page is one-way: this phone never sends sound
            bool ok = await _ua.Answer(uas, media);
            if (!ok) { EndCall("Could not answer the call (audio negotiation failed)."); return; }
            lock (_gate) { if (_call != call) return; _pendingUas = null; call.State = CallState.Connected; call.AnsweredUtc = DateTime.UtcNow; }
            RaiseCallState(call);
        }
        catch (Exception ex) { EndCall($"Could not answer the call: {ex.Message}"); }
    }

    // ------------------------------------------------------------------ in-call controls

    /// <summary>Ends whatever is going on: cancels dialing, declines a ringing call or hangs up.</summary>
    public void Hangup()
    {
        CallInfo? call; SIPServerUserAgent? uas;
        lock (_gate) { call = _call; uas = _pendingUas; }
        if (call is null) return;
        var state = call.State;
        try
        {
            switch (state)
            {
                case CallState.Incoming: uas?.Reject(SIPResponseStatusCodesEnum.Decline, "Declined"); break;
                case CallState.Dialing or CallState.Ringing: _ua?.Cancel(); break;
                default: _ua?.Hangup(); break;
            }
        }
        catch (Exception ex) { Trace?.Invoke($"Hangup error: {ex.Message}"); }
        EndCall(state == CallState.Connected ? "Call ended." : call.Incoming ? "Declined." : "Cancelled.");
    }

    public void Reject() => Hangup();

    public async Task SendDtmfAsync(char key)
    {
        if (!DialValidator.TryDtmfTone(key, out var tone)) return;
        if (CurrentCall is not { State: CallState.Connected } || _ua is null) return;
        await _ua.SendDtmf(tone);
    }

    public void SetMute(bool muted)
    {
        var call = CurrentCall;
        if (call is null || _callAudio is null) return;
        if (call.IsPage) return; // pages stay listen-only
        _callAudio.Source.Muted = muted;
        call.Muted = muted;
        RaiseCallState(call);
    }

    public async Task SetHoldAsync(bool hold)
    {
        var call = CurrentCall;
        if (call is not { State: CallState.Connected } || _ua is null || call.IsPage) return;
        if (hold) _ua.PutOnHold(); else _ua.TakeOffHold();
        call.OnHold = hold;
        RaiseCallState(call);
        await Task.CompletedTask;
    }

    // ------------------------------------------------------------------ helpers

    private IMediaSession CreateMedia()
    {
        _callAudio?.Dispose();
        _callAudio = _audio.Create();
        _session = new VoIPMediaSession(new MediaEndPoints { AudioSource = _callAudio.Source, AudioSink = _callAudio.Sink })
        {
            AcceptRtpFromAny = true,
        };
        return _session;
    }

    private void EndCall(string reason)
    {
        CallInfo? call; ICallAudio? audio; VoIPMediaSession? session;
        lock (_gate)
        {
            call = _call; if (call is null) return;
            _call = null; _pendingUas = null;
            audio = _callAudio; _callAudio = null;
            session = _session; _session = null;
        }
        _audio.StopTone();
        try { session?.Close("call ended"); } catch { }
        try { audio?.Dispose(); } catch { }
        var duration = call.AnsweredUtc is { } a ? DateTime.UtcNow - a : TimeSpan.Zero;
        CallEnded?.Invoke(new CallEndInfo(call, reason, duration, call.AnsweredUtc is not null));
    }

    private void RaiseCallState(CallInfo call) => CallStateChanged?.Invoke(call);
}
