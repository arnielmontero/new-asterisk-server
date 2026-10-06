using System.Net;
using SIPSorcery.Media;
using SIPSorceryMedia.Abstractions;

namespace SipPhone.Core;

/// <summary>The G.711 formats this PBX allows for phones (pjsip.conf: allow = ulaw, alaw).</summary>
public static class PhoneCodecs
{
    public static List<AudioFormat> Supported() => new()
    {
        new AudioFormat(SDPWellKnownMediaFormatsEnum.PCMU),
        new AudioFormat(SDPWellKnownMediaFormatsEnum.PCMA),
    };
}

/// <summary>
/// Audio going to the other party. The device layer pushes 8 kHz mono 16-bit PCM (any chunk size that is a
/// multiple of 20 ms is fine); this class encodes it with the negotiated G.711 format and raises RTP samples.
/// </summary>
public sealed class PcmAudioSource : IAudioSource, IDisposable
{
    public const int SampleRate = 8000;
    public const int FrameSamples = 160; // 20 ms

    private readonly AudioEncoder _encoder = new(PhoneCodecs.Supported().ToArray());
    private readonly List<AudioFormat> _formats = PhoneCodecs.Supported();
    private AudioFormat _format = new(SDPWellKnownMediaFormatsEnum.PCMU);
    private readonly List<short> _pending = new();
    private readonly object _lock = new();
    private volatile bool _started;
    private volatile bool _paused;

    /// <summary>When true the microphone is replaced by nothing at all (no packets of silence are faked).</summary>
    public volatile bool Muted;

    /// <summary>RTP packets handed to the stack (diagnostics).</summary>
    public long PacketsSent;

    public event Action? Started;
    public event Action? Stopped;

    public event EncodedSampleDelegate? OnAudioSourceEncodedSample;
#pragma warning disable CS0067
    public event Action<EncodedAudioFrame>? OnAudioSourceEncodedFrameReady;
    public event RawAudioSampleDelegate? OnAudioSourceRawSample;
    public event SourceErrorDelegate? OnAudioSourceError;
#pragma warning restore CS0067

    /// <summary>Feed captured PCM (8 kHz, mono, 16-bit).</summary>
    public void Push(ReadOnlySpan<short> pcm)
    {
        if (!_started || _paused || Muted) { lock (_lock) _pending.Clear(); return; }
        var handler = OnAudioSourceEncodedSample;
        if (handler is null) return;
        List<short[]> frames = new();
        lock (_lock)
        {
            _pending.AddRange(pcm.ToArray());
            while (_pending.Count >= FrameSamples)
            {
                frames.Add(_pending.GetRange(0, FrameSamples).ToArray());
                _pending.RemoveRange(0, FrameSamples);
            }
        }
        foreach (var frame in frames)
        {
            var encoded = _encoder.EncodeAudio(frame, _format);
            handler((uint)FrameSamples, encoded);
            Interlocked.Increment(ref PacketsSent);
        }
    }

    public Task StartAudio() { _started = true; Started?.Invoke(); return Task.CompletedTask; }
    public Task PauseAudio() { _paused = true; return Task.CompletedTask; }
    public Task ResumeAudio() { _paused = false; return Task.CompletedTask; }
    public Task CloseAudio() { _started = false; Stopped?.Invoke(); return Task.CompletedTask; }
    public List<AudioFormat> GetAudioSourceFormats() => _formats;
    public void SetAudioSourceFormat(AudioFormat audioFormat) => _format = audioFormat;
    public void RestrictFormats(Func<AudioFormat, bool> filter)
    {
        _formats.RemoveAll(f => !filter(f));
        if (_formats.Count > 0 && !_formats.Contains(_format)) _format = _formats[0];
    }
    public void ExternalAudioSourceRawSample(AudioSamplingRatesEnum samplingRate, uint durationMilliseconds, short[] sample) { }
    public bool HasEncodedAudioSubscribers() => OnAudioSourceEncodedSample is not null;
    public bool IsAudioSourcePaused() => _paused;
    public void Dispose() => _encoder.Dispose();
}

/// <summary>Audio arriving from the other party: decodes RTP payloads to 8 kHz PCM for the playback device.</summary>
public sealed class PcmAudioSink : IAudioSink, IDisposable
{
    private readonly AudioEncoder _decoder = new(PhoneCodecs.Supported().ToArray());
    private readonly List<AudioFormat> _formats = PhoneCodecs.Supported();
    private AudioFormat _format = new(SDPWellKnownMediaFormatsEnum.PCMU);

    /// <summary>RTP audio packets received (diagnostics).</summary>
    public long PacketsReceived;
    public long FramesReceived;

    public event Action? Started;
    public event Action? Stopped;
    /// <summary>Decoded PCM, 8 kHz mono 16-bit.</summary>
    public event Action<short[]>? PcmReceived;
#pragma warning disable CS0067
    public event SourceErrorDelegate? OnAudioSinkError;
#pragma warning restore CS0067

    public void GotAudioRtp(IPEndPoint remoteEndPoint, uint ssrc, uint seqnum, uint timestamp, int payloadID, bool marker, byte[] payload)
    {
        Interlocked.Increment(ref PacketsReceived);
        if (Interlocked.Read(ref FramesReceived) > 0) return;
        var format = _formats.FirstOrDefault(f => f.FormatID == payloadID);
        if (format.IsEmpty()) return; // comfort noise, telephone-event or something we did not offer
        var pcm = _decoder.DecodeAudio(payload, format);
        if (pcm.Length > 0) PcmReceived?.Invoke(pcm);
    }

    /// <summary>SIPSorcery 10 hands received audio to the sink as decoded-ready frames (not through GotAudioRtp).</summary>
    public void GotEncodedMediaFrame(EncodedAudioFrame encodedMediaFrame)
    {
        Interlocked.Increment(ref FramesReceived);
        var format = encodedMediaFrame.AudioFormat;
        if (format.IsEmpty() || encodedMediaFrame.EncodedAudio is not { Length: > 0 } payload) return;
        if (!_formats.Any(f => f.FormatID == format.FormatID)) return; // telephone-event, comfort noise, ...
        var pcm = _decoder.DecodeAudio(payload, format);
        if (pcm.Length > 0) PcmReceived?.Invoke(pcm);
    }
    public List<AudioFormat> GetAudioSinkFormats() => _formats;
    public void SetAudioSinkFormat(AudioFormat audioFormat) => _format = audioFormat;
    public void RestrictFormats(Func<AudioFormat, bool> filter) => _formats.RemoveAll(f => !filter(f));
    public Task PauseAudioSink() => Task.CompletedTask;
    public Task ResumeAudioSink() => Task.CompletedTask;
    public Task StartAudioSink() { Started?.Invoke(); return Task.CompletedTask; }
    public Task CloseAudioSink() { Stopped?.Invoke(); return Task.CompletedTask; }
    public void Dispose() => _decoder.Dispose();
}

/// <summary>One call's audio path. The Windows app implements it with the sound card, the self-test with tones.</summary>
public interface ICallAudio : IDisposable
{
    PcmAudioSource Source { get; }
    PcmAudioSink Sink { get; }
}

public interface ICallAudioFactory
{
    ICallAudio Create();
    /// <summary>Short tones for ring and ringback; implementations may ignore them (self-test).</summary>
    void StartTone(ToneKind kind);
    void StopTone();
}

public enum ToneKind { Ring, Ringback, Busy }
