using SIPSorcery.SIP;

namespace SipPhone.Core;

public static class SipHeaders
{
    /// <summary>
    /// Value of a header by name, case-insensitive. SIPSorcery parses some headers (Call-Info among them) into
    /// internal state, so GetUnknownHeaderValue alone misses them; the serialised header block always has them.
    /// </summary>
    public static string? Get(SIPRequest request, string name)
    {
        var unknown = request.Header.GetUnknownHeaderValue(name);
        if (!string.IsNullOrEmpty(unknown)) return unknown;
        return FindInHeaderBlock(request.Header.ToString(), name);
    }

    public static string? FindInHeaderBlock(string headerBlock, string name)
    {
        foreach (var line in headerBlock.Split('\n'))
        {
            var trimmed = line.TrimEnd('\r');
            int colon = trimmed.IndexOf(':');
            if (colon <= 0) continue;
            if (trimmed[..colon].Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
                return trimmed[(colon + 1)..].Trim();
        }
        return null;
    }
}
