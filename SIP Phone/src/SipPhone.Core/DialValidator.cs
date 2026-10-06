using System.Text.RegularExpressions;

namespace SipPhone.Core;

public static class DialValidator
{
    private static readonly Regex Allowed = new(@"^[0-9*#+]{1,32}$", RegexOptions.Compiled);

    /// <summary>Strips spaces, dashes and brackets people type, then accepts digits, * # and a leading +.</summary>
    public static bool TryNormalize(string? input, out string number)
    {
        number = "";
        if (string.IsNullOrWhiteSpace(input)) return false;
        var cleaned = new string(input.Where(c => !(char.IsWhiteSpace(c) || c is '-' or '(' or ')' or '.')).ToArray());
        if (!Allowed.IsMatch(cleaned)) return false;
        if (cleaned.IndexOf('+') > 0) return false; // + only as the first character
        number = cleaned;
        return true;
    }

    /// <summary>DTMF tone number for RFC 4733: 0-9, * = 10, # = 11.</summary>
    public static bool TryDtmfTone(char key, out byte tone)
    {
        if (key >= '0' && key <= '9') { tone = (byte)(key - '0'); return true; }
        if (key == '*') { tone = 10; return true; }
        if (key == '#') { tone = 11; return true; }
        tone = 0; return false;
    }
}
