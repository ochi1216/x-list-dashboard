# PC側(Windows)取得スクリプトの更新案

`home-pc-workspace/x-follow-list/scripts/daily-x-fetch.ps1` に、取得の失敗をntfyへ通知する処理(`Send-FetchReport`)を足した版です(2026-11-02)。

- `daily-x-fetch.ps1`: 更新後の全文(UTF-8 BOM付き・CRLF)。PCの同名ファイルを、これで置き換える。
- `daily-x-fetch.diff`: 元のファイルとの差分(確認用)。
- 通知先(ntfyのトピック)はPCに置かない。サーバーの `fetch_report`(migration 009)が、既存の通知経路で送る。
- 検知する失敗: 認証切れ(auth_expired)/Chrome拡張の未接続(extension_not_connected)/claudeの異常終了(run_failed)。同じ種類は360分に1回へ束ねられる。
- 反映手順: PCで上のファイルを `x-follow-list\scripts\daily-x-fetch.ps1` へ上書き(または `git apply`)し、home-pc-workspace に commit する。次回の実行から有効。
