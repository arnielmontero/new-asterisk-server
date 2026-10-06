using System.Text.RegularExpressions;

namespace SipPhone.Core;

/// <summary>
/// Same rule as the browser (frontend/src/paging-detect.js): a call may be auto-answered as a page only when
/// the caller is a paging group AND X-Paging-Call is exactly "true" AND Call-Info carries answer-after=0.
/// A generic Call-Info header alone is never enough.
/// </summary>
public static class PagingDetect
{
    public static readonly IReadOnlyList<string> PagingCallers = new[] { "700", "701", "702" };

    private static readonly Regex AnswerAfterZero =
        new(@"(?:^|[;,\s])answer-after=0(?=\s*(?:[;,]|$))", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static bool IsPagingInvite(string? callerUser, string? pagingHeader, string? callInfoHeader)
    {
        if (callerUser is null || !PagingCallers.Contains(callerUser)) return false;
        if (pagingHeader is null || pagingHeader.Trim() != "true") return false;
        if (callInfoHeader is null || !AnswerAfterZero.IsMatch(callInfoHeader)) return false;
        return true;
    }

    public static string GroupName(string? callerUser) => callerUser switch
    {
        "700" => "All",
        "701" => "Office",
        "702" => "Warehouse",
        _ => "Paging",
    };
}
