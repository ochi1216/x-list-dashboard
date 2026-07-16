# Next Task

## Session Management

* Project Name: X List Dashboard
* Previous Session: S01 - 引継ぎ管理の初期設定
* Next Session Number: S02
* Recommended Session Title: `X List Dashboard S02 - （ユーザー指定のタスク内容）`

## Objective

* ユーザーから次のタスク指示を受ける。

## Background

* 現在の状態: `index.html` 単一ファイルの静的ダッシュボードとして、投稿一覧表示・既読管理・お気に入り・検索・グループ化・読み上げ機能が実装済み（詳細は `docs/PROJECT_STATUS.md` 参照）。データはSupabaseの `public.x_posts` テーブルから取得。
* 前回までに完了した内容: セッション間引き継ぎ管理ファイル一式（`CLAUDE.md`, `docs/PROJECT_STATUS.md`, `docs/SESSION_HISTORY.md`, `docs/NEXT_TASK.md`）の初期設定（S01）。コード本体の変更は無し。

## Scope

### Files That May Be Changed

* 次タスクの内容に応じてユーザーが指定するファイル（本ファイル作成時点では未確定）。

### Files That Must Not Be Changed

* 次タスクと無関係なファイル全般。
* 特にSupabase上の `x_posts` 以外のテーブル（`aikido_2026_*`, `ti_video_*`, `news_articles`, `learning_logs` 等、別プロジェクトと共用のSupabaseインスタンス上に存在）には触れない。

## Task

1. （次タスク未確定のため空欄）
2.
3.

## Completion Criteria

* 次タスクの内容確定後、このセクションを具体化する。

## Required Tests

* 次タスクの内容に応じて、`verify` スキル等を用いた実動作確認を行う（フロントエンドのみの静的サイトのため、ブラウザでの手動確認が基本となる見込み）。

## Known Risks

* `x_posts` テーブルへのデータ供給元（外部の収集処理）の実体が本リポジトリ内で未確認のため、データ関連の変更を行う場合は影響範囲の事前確認が必要。
* SupabaseのRLS設定・publishable keyの権限範囲が未確認のため、書き込み系の変更を行う場合は事前に権限を確認する。

## Start Prompt

```
X List Dashboard S02 セッションを開始します。
まず CLAUDE.md、docs/PROJECT_STATUS.md、docs/SESSION_HISTORY.md、docs/NEXT_TASK.md を読み込んでください。
今回のタスク: （ここに具体的なタスク内容を記載してください）
```
