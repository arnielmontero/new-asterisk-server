namespace SipPhone.Core;

/// <summary>Everything the phone needs to register with the PBX. Mirrors DEPLOYMENT.md section 9.</summary>
public sealed class PhoneSettings
{
    /// <summary>PBX address: the server's LAN IP or host name.</summary>
    public string Server { get; set; } = "";
    /// <summary>SIP/UDP port of the PBX (Asterisk PJSIP transport).</summary>
    public int Port { get; set; } = 5060;
    /// <summary>Register name = auth ID, for example 1001-phone.</summary>
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    /// <summary>Name shown in the From header. The PBX overwrites the caller ID with 1001/1002.</summary>
    public string DisplayName { get; set; } = "";
    /// <summary>Registration lifetime in seconds. The registration is refreshed before it runs out.</summary>
    public int RegisterExpirySeconds { get; set; } = 300;
    /// <summary>Answer paging calls (700/701/702 with the paging markers) by itself, listen-only.</summary>
    public bool AutoAnswerPages { get; set; } = true;
    /// <summary>Local UDP port for SIP; 0 lets the operating system choose.</summary>
    public int LocalSipPort { get; set; }
    /// <summary>Capture device name; empty = system default.</summary>
    public string InputDevice { get; set; } = "";
    /// <summary>Playback device name; empty = system default.</summary>
    public string OutputDevice { get; set; } = "";
    /// <summary>Speaker volume, 0..100.</summary>
    public int Volume { get; set; } = 80;

    /// <summary>Returns null when the settings are usable, otherwise a message for the user.</summary>
    public string? Validate()
    {
        if (string.IsNullOrWhiteSpace(Server)) return "Enter the server address.";
        if (Server.Trim().Any(c => char.IsWhiteSpace(c) || c == ':' || c == '/' || c == '@' || c == '<' || c == '>' || c == ';'))
            return "The server address must be a host name or IP address only (no sip: prefix, no port).";
        if (Port < 1 || Port > 65535) return "The port must be between 1 and 65535.";
        if (string.IsNullOrWhiteSpace(Username)) return "Enter the SIP user (for example 1001-phone).";
        if (Username.Trim().Any(c => !(char.IsLetterOrDigit(c) || c is '-' or '_' or '.' or '+')))
            return "The SIP user may contain only letters, digits and - _ . +";
        if (string.IsNullOrEmpty(Password)) return "Enter the password.";
        if (RegisterExpirySeconds < 60 || RegisterExpirySeconds > 3600) return "The registration time must be between 60 and 3600 seconds.";
        if (LocalSipPort < 0 || LocalSipPort > 65535) return "The local SIP port must be 0 (automatic) or 1-65535.";
        return null;
    }

    public PhoneSettings Clone() => (PhoneSettings)MemberwiseClone();
}
