namespace SipPhone.Core;

/// <summary>Plain-language reasons for the SIP failure codes this PBX can produce.</summary>
public static class CallFailureText
{
    public static string ForStatus(int code, string? reason = null) => code switch
    {
        400 => "The server did not understand the request.",
        401 or 407 => "The server refused the login: check the SIP user and password.",
        403 => "The server refused this call (not allowed for this phone).",
        404 => "That number does not exist on this system.",
        408 => "The server did not answer in time.",
        480 => "The person is not available (not registered).",
        486 => "The line is busy.",
        487 => "The call was cancelled.",
        488 => "No common audio format with the server (this phone offers G.711 only).",
        500 => "The server reported an internal error.",
        503 => "The telephony service is unavailable right now.",
        603 => "The call was declined.",
        _ => string.IsNullOrWhiteSpace(reason) ? $"The call failed (SIP {code})." : $"The call failed (SIP {code}: {reason}).",
    };
}
