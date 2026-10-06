using SipPhone.Core;

namespace SipPhone.Tests;

public class PagingDetectTests
{
    private const string Good = "<sip:communications.local>;answer-after=0";

    [Fact]
    public void AllThreeMarkersFromAPagingGroupAreAPage()
    {
        foreach (var group in new[] { "700", "701", "702" })
            Assert.True(PagingDetect.IsPagingInvite(group, "true", Good));
    }

    [Theory]
    [InlineData("1002")]   // a normal extension is never a page
    [InlineData("600")]
    [InlineData("7000")]
    [InlineData("")]
    [InlineData(null)]
    public void NonPagingCallersAreNeverPages(string? caller) => Assert.False(PagingDetect.IsPagingInvite(caller, "true", Good));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("false")]
    [InlineData("TRUE")]
    [InlineData("yes")]
    public void ThePagingHeaderMustBeExactlyTrue(string? header) => Assert.False(PagingDetect.IsPagingInvite("701", header, Good));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("<sip:communications.local>")]                          // a generic Call-Info is never enough
    [InlineData("<sip:communications.local>;answer-after=5")]
    [InlineData("<sip:communications.local>;answer-after=00")]
    [InlineData("<sip:communications.local>;xanswer-after=0")]
    public void CallInfoMustCarryAnswerAfterZero(string? callInfo) => Assert.False(PagingDetect.IsPagingInvite("701", "true", callInfo));

    [Fact]
    public void AnswerAfterZeroIsFoundAmongOtherParameters()
    {
        Assert.True(PagingDetect.IsPagingInvite("700", " true ", "<sip:x>;purpose=icon;answer-after=0;foo=bar"));
        Assert.True(PagingDetect.IsPagingInvite("700", "true", "<sip:x>; ANSWER-AFTER=0"));
    }

    [Fact]
    public void GroupNamesMatchTheServer()
    {
        Assert.Equal("All", PagingDetect.GroupName("700"));
        Assert.Equal("Office", PagingDetect.GroupName("701"));
        Assert.Equal("Warehouse", PagingDetect.GroupName("702"));
    }
}

public class DialValidatorTests
{
    [Theory]
    [InlineData("1002", "1002")]
    [InlineData(" 600 ", "600")]
    [InlineData("1 0 0 2", "1002")]
    [InlineData("(100) 2", "1002")]
    [InlineData("+63-917-555-0100", "+639175550100")]
    [InlineData("*97", "*97")]
    [InlineData("#31#", "#31#")]
    public void AcceptsAndNormalisesDialledNumbers(string typed, string expected)
    {
        Assert.True(DialValidator.TryNormalize(typed, out var number));
        Assert.Equal(expected, number);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("12abc")]
    [InlineData("sip:1002@host")]
    [InlineData("1002;transport=tcp")]
    [InlineData("100+2")]
    [InlineData("1002\r\nINVITE")]
    [InlineData("123456789012345678901234567890123")] // 33 characters
    public void RejectsAnythingThatIsNotADialString(string? typed) => Assert.False(DialValidator.TryNormalize(typed, out _));

    [Theory]
    [InlineData('0', 0)] [InlineData('9', 9)] [InlineData('*', 10)] [InlineData('#', 11)]
    public void DtmfTones(char key, int tone)
    {
        Assert.True(DialValidator.TryDtmfTone(key, out var t));
        Assert.Equal(tone, t);
    }

    [Theory]
    [InlineData('a')] [InlineData(' ')] [InlineData('+')]
    public void NonDtmfKeysAreIgnored(char key) => Assert.False(DialValidator.TryDtmfTone(key, out _));
}

public class PhoneSettingsTests
{
    private static PhoneSettings Valid() => new() { Server = "192.168.1.100", Username = "1001-phone", Password = "secret-password" };

    [Fact] public void ValidSettingsPass() => Assert.Null(Valid().Validate());

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("sip:192.168.1.100")]
    [InlineData("192.168.1.100/")]
    [InlineData("user@host")]
    [InlineData("a b")]
    public void BadServerAddressesAreRefused(string server)
    {
        var s = Valid(); s.Server = server;
        Assert.NotNull(s.Validate());
    }

    [Theory]
    [InlineData(0)] [InlineData(70000)] [InlineData(-1)]
    public void BadPortsAreRefused(int port)
    {
        var s = Valid(); s.Port = port;
        Assert.NotNull(s.Validate());
    }

    [Theory]
    [InlineData("")]
    [InlineData("with space")]
    [InlineData("a;b")]
    [InlineData("<x>")]
    public void BadUsersAreRefused(string user)
    {
        var s = Valid(); s.Username = user;
        Assert.NotNull(s.Validate());
    }

    [Fact]
    public void EmptyPasswordIsRefused()
    {
        var s = Valid(); s.Password = "";
        Assert.NotNull(s.Validate());
    }

    [Fact]
    public void CloneIsIndependent()
    {
        var a = Valid(); var b = a.Clone(); b.Server = "other";
        Assert.Equal("192.168.1.100", a.Server);
    }
}

public class SipHeadersTests
{
    private const string Block =
        "Via: SIP/2.0/UDP 192.168.65.3:5060\r\nCall-Info: <sip:communications.local>;answer-after=0\r\nX-Paging-Call: true\r\nContent-Length: 0\r\n";

    [Fact]
    public void FindsHeadersCaseInsensitively()
    {
        Assert.Equal("<sip:communications.local>;answer-after=0", SipHeaders.FindInHeaderBlock(Block, "call-info"));
        Assert.Equal("true", SipHeaders.FindInHeaderBlock(Block, "X-PAGING-CALL"));
    }

    [Fact]
    public void MissingHeaderIsNull() => Assert.Null(SipHeaders.FindInHeaderBlock(Block, "X-Nothing"));

    [Fact]
    public void ANameThatIsOnlyAPrefixDoesNotMatch() => Assert.Null(SipHeaders.FindInHeaderBlock(Block, "X-Paging"));
}

public class CallFailureTextTests
{
    [Theory]
    [InlineData(401, "password")]
    [InlineData(404, "does not exist")]
    [InlineData(486, "busy")]
    [InlineData(503, "unavailable")]
    public void KnownCodesGetPlainLanguage(int code, string fragment) =>
        Assert.Contains(fragment, CallFailureText.ForStatus(code), StringComparison.OrdinalIgnoreCase);

    [Fact]
    public void UnknownCodesStillShowTheNumber() => Assert.Contains("418", CallFailureText.ForStatus(418, "Teapot"));
}

public class PcmAudioTests
{
    [Fact]
    public void SourceEncodesTwentyMillisecondFrames()
    {
        using var source = new PcmAudioSource();
        var sent = new List<(uint duration, int bytes)>();
        source.OnAudioSourceEncodedSample += (d, b) => sent.Add((d, b.Length));
        source.StartAudio();
        source.Push(new short[480]); // 60 ms
        Assert.Equal(3, sent.Count);
        Assert.All(sent, s => { Assert.Equal(160u, s.duration); Assert.Equal(160, s.bytes); }); // G.711: 1 byte per sample
    }

    [Fact]
    public void MutedSourceSendsNothing()
    {
        using var source = new PcmAudioSource();
        int packets = 0;
        source.OnAudioSourceEncodedSample += (_, _) => packets++;
        source.StartAudio();
        source.Muted = true;
        source.Push(new short[1600]);
        Assert.Equal(0, packets);
        source.Muted = false;
        source.Push(new short[320]);
        Assert.Equal(2, packets);
    }

    [Fact]
    public void PartialFramesAreKeptUntilComplete()
    {
        using var source = new PcmAudioSource();
        int packets = 0;
        source.OnAudioSourceEncodedSample += (_, _) => packets++;
        source.StartAudio();
        source.Push(new short[100]);
        Assert.Equal(0, packets);
        source.Push(new short[100]);
        Assert.Equal(1, packets);
    }

    [Fact]
    public void SinkDecodesWhatTheSourceEncodes()
    {
        using var source = new PcmAudioSource();
        using var sink = new PcmAudioSink();
        var tone = new short[160];
        for (int i = 0; i < tone.Length; i++) tone[i] = (short)(Math.Sin(2 * Math.PI * 440 * i / 8000.0) * 10000);

        short[]? decoded = null;
        sink.PcmReceived += pcm => decoded = pcm;
        source.OnAudioSourceEncodedSample += (_, bytes) =>
            sink.GotEncodedMediaFrame(new SIPSorceryMedia.Abstractions.EncodedAudioFrame(0, new SIPSorceryMedia.Abstractions.AudioFormat(SIPSorceryMedia.Abstractions.SDPWellKnownMediaFormatsEnum.PCMU), 20, bytes));
        source.StartAudio();
        source.Push(tone);

        Assert.NotNull(decoded);
        Assert.Equal(160, decoded!.Length);
        // G.711 is lossy but close: every sample within a few percent of the original
        for (int i = 0; i < tone.Length; i++) Assert.InRange(Math.Abs(tone[i] - decoded[i]), 0, 700);
    }
}
