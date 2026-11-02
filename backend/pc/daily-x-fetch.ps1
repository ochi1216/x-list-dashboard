# Windows Task Scheduler runs this at 03:00 and 16:30 JST to fetch/register/summarize
# new posts from the X list "FollowList-AI" via the x-list-tracker skill (two runs/day
# since 2026-08-04, so the 07:00 and 18:00 commute-time reads both have fresh data).
# Requires: PC on and logged into X in Chrome's default profile, Claude Code CLI on PATH.
# Chrome no longer needs to be left open manually -- this script launches it if it
# isn't already running (2026-07-14, after repeated silent 0-registration failures
# where the claude-in-chrome extension had nothing to attach to because Chrome was
# closed overnight).
#
# 2026-09-22: home-pc-workspace/x-follow-list/ へ移管。$ProjectDir を変更した以外の
# ロジックは移管前(C:\Users\ochi1\Documents\Scripts\Supabase\)と同一。
# タスクスケジューラ「X-List-Daily-Fetch」の「操作」タブの実行対象パスも
# このファイルの新しい場所に合わせて更新すること（移行手順参照）。

$ProjectDir = "C:\Users\ochi1\OneDrive\ドキュメント\PythonScripts\home-pc-workspace\x-follow-list"
$LogDir = Join-Path $ProjectDir "logs"
$LogFile = Join-Path $LogDir ("x-fetch-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

Set-Location $ProjectDir

# 2026-11-02: 取得の失敗を数秒でntfyへ通知する(2026-11-01/02の約30時間の無通知停止を受けて追加)。
# 通知先(ntfyのトピック)はPCに置かず、サーバー(Supabase)の関数 fetch_report が既存の通知経路で送る。
# 失敗の種類: auth_expired / extension_not_connected / run_failed。同じ種類は360分に1回へ束ねられる。
# 通知の失敗で取得そのものは止めない(ログに残すだけ)。
$SupabaseUrl = "https://bpdkdwtevqsqgsxlahmd.supabase.co"
$NotifyAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwZGtkd3RldnFzcWdzeGxhaG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NjAzOTcsImV4cCI6MjA5ODEzNjM5N30.zfxxhgVCmZAGrk2LiSnPpEHg72mjdJne3c6YOXBeCTs"
function Send-FetchReport([string]$Kind, [string]$Detail) {
    try {
        $body = @{ p_kind = $Kind; p_detail = $Detail } | ConvertTo-Json -Compress
        $null = Invoke-RestMethod -Method Post -Uri "$SupabaseUrl/rest/v1/rpc/fetch_report" `
            -Headers @{ "apikey" = $NotifyAnonKey; "Authorization" = "Bearer $NotifyAnonKey" } `
            -ContentType "application/json" -Body $body -TimeoutSec 20
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ntfy notified via fetch_report: $Kind" | Out-File -FilePath $LogFile -Append -Encoding utf8
    } catch {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ntfy notify FAILED ($Kind): $($_.Exception.Message)" | Out-File -FilePath $LogFile -Append -Encoding utf8
    }
}

# Launch Chrome (existing default profile, so saved X login cookies still apply) if
# it isn't already running, and give it a moment to finish starting up before the
# extension needs to attach to it.
# 2026-09-20: 無人実行(深夜3時/16:30)でChromeウィンドウがデスクトップ上に表示され、
# 作業の邪魔になっていたため、新規起動時のウィンドウ位置を画面外に指定する。
# 既にChrome起動中の場合はこの分岐を通らないため、通常使用中のウィンドウには影響しない。
if (-not (Get-Process chrome -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $ChromePath -ArgumentList "--window-position=-2000,-2000"
    Start-Sleep -Seconds 15
}

# ANTHROPIC_API_KEY is set as a User env var for other work on this machine, but its
# presence makes Claude Code prefer API-key auth over the claude.ai login, which disables
# MCP connectors (claude-in-chrome, Supabase) that this skill needs. Clear it for this
# process only (does not touch the persistent User env var used elsewhere).
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

# Write a start marker before the (potentially long, since "exhaustive coverage" was
# made mandatory 2026-07-13) claude run. Previously the log line was only written
# after claude returned, so a run that got killed by the task's execution time limit
# left no trace at all -- the failure was invisible. Now even a killed run shows up
# as "started but never finished" instead of a missing log file.
$startTimestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$startTimestamp] ---- daily-x-fetch run STARTED ----" | Out-File -FilePath $LogFile -Append -Encoding utf8

$prompt = @'
x-list-trackerスキルを使って、Xリスト「FollowList-AI」の本日分の新着投稿を取得・登録・要約してください。
これは深夜の無人自動実行なので、質問や確認は一切せず、スキルに書かれた既定の手順どおりに進めてください。
作業を始める前に、同じリストの旧タブ・タブグループが残っていればすべて閉じてから、新しいタブで開き直してください（前回が異常終了した場合の残骸を防ぐため）。
取得は全件網羅を優先してください（スキルに明記された通り、前回のカットオフ〈直近のposted_at/post_url〉に到達する、またはそれより古い投稿が繰り返し出てくるまでスクロールを継続すること）。
ただし、投稿の投稿日時が「直近3日」より古くなった時点で、それ以上は遡らず打ち切ってください。これは、認証切れ等でカットオフが数週間〜数ヶ月前まで開いてしまった場合に、実行時間が際限なく延びるのを防ぐための上限です。
3日以内の範囲であれば、件数が多い日でも時間がかかっても打ち切らないでください。重複登録は on conflict do nothing で自動的に防止されるため、スクロールしすぎる／登録しすぎることを心配する必要は一切ありません。「安全側」を理由に3日以内で早めに切り上げる判断はしないでください。
Chromeが開いていない、Xにログインしていない等でリストが読めない場合は、無理に続けず、その旨を最後の報告に一言書いてください。
作業に使ったブラウザタブは、終了前に必ずtabs_close_mcpで閉じてください（毎晩タブグループが開きっぱなしで溜まっていくのを防ぐため）。
スキルの手順6でfetch_runsに記録する際は、この実行はsourceを'scheduled'にしてください（通常のチャット経由の手動実行と区別するため）。
3日の上限に達して打ち切った場合は、その旨も最後の報告に一言書いてください（例:「3日超の投稿は対象外としました」）。
最後に「新規登録N件、要約完了M件」のように1行で簡潔に結果を報告してください。
'@

$output = & claude -p $prompt --chrome --permission-mode bypassPermissions --output-format text 2>&1
$claudeExit = $LASTEXITCODE

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$timestamp] ---- daily-x-fetch run FINISHED ----" | Out-File -FilePath $LogFile -Append -Encoding utf8
$output | Out-File -FilePath $LogFile -Append -Encoding utf8

# Auth-failure detection (added 2026-08-13, after two consecutive days of silent
# 0-registration failures went unnoticed until the user asked why the dashboard
# wasn't updating). This is a distinct failure mode from the freshness check below:
# it fires immediately from $output itself rather than waiting on a Supabase query,
# and it names the exact fix (`claude auth login`) instead of just flagging staleness.
$outputText = $output -join "`n"
if ($outputText -match "Failed to authenticate" -or $outputText -match "OAuth session expired") {
    "[$timestamp] !!!! AUTH EXPIRED: claude CLI's login session has expired -- run 'claude auth login' interactively to restore automated fetching. This run made no Chrome/X connection at all. !!!!" | Out-File -FilePath $LogFile -Append -Encoding utf8
    Send-FetchReport "auth_expired" ""
}
elseif ($outputText -match "no browser is connected" -or $outputText -match "extension is not connected" -or $outputText -match "Browser extension is not connected") {
    # 2026-11-02: Chrome拡張(claude-in-chrome)が接続されておらず、リストを読めずに終了した場合
    "[$timestamp] !!!! EXTENSION NOT CONNECTED: claude-in-chrome extension is not connected -- open Chrome and check '/chrome' in 'claude --chrome'. This run read no posts. !!!!" | Out-File -FilePath $LogFile -Append -Encoding utf8
    Send-FetchReport "extension_not_connected" ""
}
elseif ($claudeExit -ne 0) {
    "[$timestamp] !!!! RUN FAILED: claude exited with code $claudeExit !!!!" | Out-File -FilePath $LogFile -Append -Encoding utf8
    Send-FetchReport "run_failed" "exit code $claudeExit"
}

# Freshness self-check (added 2026-08-04, after a 2026-08-03 run silently missed
# ~16.5 hours of posts despite exiting cleanly). Supabase-side cron jobs can't see
# PC/browser-side fetch failures, so check directly here: if the newest post in the
# DB is older than expected right after a run just finished, log a loud warning so
# a repeat of that gap shows up in the log instead of going unnoticed until someone
# happens to compare counts by hand.
try {
    $anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwZGtkd3RldnFzcWdzeGxhaG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NjAzOTcsImV4cCI6MjA5ODEzNjM5N30.zfxxhgVCmZAGrk2LiSnPpEHg72mjdJne3c6YOXBeCTs"
    $resp = Invoke-RestMethod -Uri "https://bpdkdwtevqsqgsxlahmd.supabase.co/rest/v1/x_posts?select=posted_at&order=posted_at.desc.nullslast&limit=1" `
        -Headers @{ "apikey" = $anonKey; "Authorization" = "Bearer $anonKey" }
    if ($resp -and $resp[0].posted_at) {
        $latest = [datetime]::Parse($resp[0].posted_at).ToUniversalTime()
        $hoursSince = (New-TimeSpan -Start $latest -End (Get-Date).ToUniversalTime()).TotalHours
        $checkTimestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        if ($hoursSince -gt 3) {
            "[$checkTimestamp] !!!! WARNING: freshness check -- latest post is $([math]::Round($hoursSince,1))h old, possible fetch gap, needs manual review !!!!" | Out-File -FilePath $LogFile -Append -Encoding utf8
        } else {
            "[$checkTimestamp] freshness check: latest post is $([math]::Round($hoursSince,1))h old (OK)" | Out-File -FilePath $LogFile -Append -Encoding utf8
        }
    } else {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] freshness check: could not read latest posted_at from Supabase (empty response)" | Out-File -FilePath $LogFile -Append -Encoding utf8
    }
} catch {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] freshness check FAILED: $($_.Exception.Message)" | Out-File -FilePath $LogFile -Append -Encoding utf8
}
