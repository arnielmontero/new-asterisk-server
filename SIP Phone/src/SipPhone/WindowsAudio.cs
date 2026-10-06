using NAudio.Wave;
using SipPhone.Core;

namespace SipPhone;

public static class AudioDevices
{
    public static List<string> Inputs()
    {
        var list = new List<string>();
        for (int i = 0; i < WaveInEvent.DeviceCount; i++) list.Add(WaveInEvent.GetCapabilities(i).ProductName);
        return list;
    }

    public static List<string> Outputs()
    {
        var list = new List<string>();
        for (int i = 0; i < WaveOut.DeviceCount; i++) list.Add(WaveOut.GetCapabilities(i).ProductName);
        return list;
    }

    /// <summary>Device index for a saved name, or -1 (the system default) when empty or no longer present.</summary>
    public static int FindInput(string name) => Find(Inputs(), name);
    public static int FindOutput(string name) => Find(Outputs(), name);

    private static int Find(List<string> devices, string name)
    {
        if (string.IsNullOrEmpty(name)) return -1;
        int i = devices.FindIndex(d => d == name);
        return i >= 0 ? i : -1;
    }
}

/// <summary>Microphone in, speaker out, for one call. 8 kHz mono 16-bit, the native G.711 format.</summary>
public sealed class WindowsCallAudio : ICallAudio
{
    private static readonly WaveFormat Format = new(8000, 16, 1);

    private readonly string _inputDevice, _outputDevice;
    private readonly Action<string> _warn;
    private WaveInEvent? _in;
    private WaveOutEvent? _out;
    private BufferedWaveProvider? _buffer;
    private float _volume;
    private readonly object _lock = new();

    public PcmAudioSource Source { get; } = new();
    public PcmAudioSink Sink { get; } = new();

    public WindowsCallAudio(string inputDevice, string outputDevice, int volumePercent, Action<string> warn)
    {
        _inputDevice = inputDevice; _outputDevice = outputDevice; _warn = warn;
        _volume = Math.Clamp(volumePercent, 0, 100) / 100f;
        Source.Started += StartInput;
        Source.Stopped += StopInput;
        Sink.Started += StartOutput;
        Sink.Stopped += StopOutput;
        Sink.PcmReceived += OnPcm;
    }

    public void SetVolume(int percent)
    {
        _volume = Math.Clamp(percent, 0, 100) / 100f;
        lock (_lock) { if (_out is not null) _out.Volume = _volume; }
    }

    private void StartInput()
    {
        try
        {
            var input = new WaveInEvent
            {
                DeviceNumber = AudioDevices.FindInput(_inputDevice),
                WaveFormat = Format,
                BufferMilliseconds = 20,
                NumberOfBuffers = 4,
            };
            input.DataAvailable += (_, e) =>
            {
                var samples = new short[e.BytesRecorded / 2];
                Buffer.BlockCopy(e.Buffer, 0, samples, 0, samples.Length * 2);
                Source.Push(samples);
            };
            input.StartRecording();
            lock (_lock) _in = input;
        }
        catch (Exception ex)
        {
            _warn($"Microphone not available ({ex.Message.Split('\n')[0]}). You can still listen; the other side will not hear you.");
        }
    }

    private void StopInput()
    {
        WaveInEvent? input;
        lock (_lock) { input = _in; _in = null; }
        try { input?.StopRecording(); input?.Dispose(); } catch { }
    }

    private void StartOutput()
    {
        try
        {
            var buffer = new BufferedWaveProvider(Format) { BufferDuration = TimeSpan.FromSeconds(1), DiscardOnBufferOverflow = true };
            var output = new WaveOutEvent { DeviceNumber = AudioDevices.FindOutput(_outputDevice), DesiredLatency = 120, NumberOfBuffers = 3 };
            output.Init(buffer);
            output.Volume = _volume;
            output.Play();
            lock (_lock) { _buffer = buffer; _out = output; }
        }
        catch (Exception ex)
        {
            _warn($"Speaker not available ({ex.Message.Split('\n')[0]}). Choose another playback device in Settings.");
        }
    }

    private void StopOutput()
    {
        WaveOutEvent? output;
        lock (_lock) { output = _out; _out = null; _buffer = null; }
        try { output?.Stop(); output?.Dispose(); } catch { }
    }

    private void OnPcm(short[] pcm)
    {
        BufferedWaveProvider? buffer;
        lock (_lock) buffer = _buffer;
        if (buffer is null) return;
        var bytes = new byte[pcm.Length * 2];
        Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length);
        buffer.AddSamples(bytes, 0, bytes.Length);
    }

    public void Dispose()
    {
        StopInput();
        StopOutput();
        Source.Dispose();
        Sink.Dispose();
    }
}

/// <summary>Creates call audio and plays the ring / ringback tones on the chosen speaker.</summary>
public sealed class WindowsAudioFactory : ICallAudioFactory, IDisposable
{
    private readonly Func<PhoneSettings> _settings;
    private readonly object _lock = new();
    private WindowsCallAudio? _current;
    private WaveOutEvent? _toneOut;

    public event Action<string>? Warning;

    public WindowsAudioFactory(Func<PhoneSettings> settings) => _settings = settings;

    public ICallAudio Create()
    {
        var s = _settings();
        var audio = new WindowsCallAudio(s.InputDevice, s.OutputDevice, s.Volume, m => Warning?.Invoke(m));
        lock (_lock) _current = audio;
        return audio;
    }

    public void SetVolume(int percent)
    {
        lock (_lock)
        {
            _current?.SetVolume(percent);
            if (_toneOut is not null) _toneOut.Volume = Math.Clamp(percent, 0, 100) / 100f;
        }
    }

    public void StartTone(ToneKind kind)
    {
        StopTone();
        try
        {
            var s = _settings();
            var pattern = kind switch
            {
                ToneKind.Ring => new[] { 0.4, 0.2, 0.4, 2.0 },     // double ring
                ToneKind.Ringback => new[] { 1.0, 4.0 },
                _ => new[] { 0.5, 0.5 },                           // busy
            };
            var provider = new CadenceTone(425, pattern);
            var output = new WaveOutEvent { DeviceNumber = AudioDevices.FindOutput(s.OutputDevice), DesiredLatency = 150 };
            output.Init(provider);
            output.Volume = Math.Clamp(s.Volume, 0, 100) / 100f;
            output.Play();
            lock (_lock) _toneOut = output;
        }
        catch (Exception ex) { Warning?.Invoke($"Cannot play the ring tone ({ex.Message.Split('\n')[0]})."); }
    }

    public void StopTone()
    {
        WaveOutEvent? output;
        lock (_lock) { output = _toneOut; _toneOut = null; }
        try { output?.Stop(); output?.Dispose(); } catch { }
    }

    /// <summary>Short beep so the user can check the chosen speaker.</summary>
    public static void PlayTestTone(string outputDevice, int volumePercent)
    {
        var provider = new CadenceTone(800, new[] { 0.5, 0.0 }, once: true);
        var output = new WaveOutEvent { DeviceNumber = AudioDevices.FindOutput(outputDevice), DesiredLatency = 150 };
        output.Init(provider);
        output.Volume = Math.Clamp(volumePercent, 0, 100) / 100f;
        output.PlaybackStopped += (_, _) => output.Dispose();
        output.Play();
    }

    public void Dispose() => StopTone();
}

/// <summary>A sine tone switched on and off by a cadence, with 5 ms ramps so it does not click.</summary>
internal sealed class CadenceTone : ISampleProvider
{
    private readonly double _frequency;
    private readonly double[] _pattern;
    private readonly bool _once;
    private long _position;
    private readonly long _cycleSamples;

    public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(8000, 1);

    public CadenceTone(double frequency, double[] patternSeconds, bool once = false)
    {
        _frequency = frequency; _pattern = patternSeconds; _once = once;
        _cycleSamples = (long)(patternSeconds.Sum() * WaveFormat.SampleRate);
    }

    public int Read(float[] buffer, int offset, int count)
    {
        const int ramp = 40; // 5 ms at 8 kHz
        for (int n = 0; n < count; n++)
        {
            if (_once && _position >= _cycleSamples) return n;
            long inCycle = _position % _cycleSamples;
            double t = 0; bool on = false; long segmentStart = 0, segmentEnd = 0;
            for (int i = 0; i < _pattern.Length; i++)
            {
                long len = (long)(_pattern[i] * WaveFormat.SampleRate);
                if (inCycle < t * WaveFormat.SampleRate + len) { on = i % 2 == 0; segmentStart = (long)(t * WaveFormat.SampleRate); segmentEnd = segmentStart + len; break; }
                t += _pattern[i];
            }
            float sample = 0;
            if (on)
            {
                double gain = Math.Min(1.0, Math.Min((inCycle - segmentStart) / (double)ramp, (segmentEnd - inCycle) / (double)ramp));
                sample = (float)(Math.Sin(2 * Math.PI * _frequency * _position / WaveFormat.SampleRate) * 0.25 * gain);
            }
            buffer[offset + n] = sample;
            _position++;
        }
        return count;
    }
}
