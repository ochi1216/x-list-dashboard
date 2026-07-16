# Project Status

最終更新: 2026-07-16 (S01)

## 1. Project Overview

* プロジェクト名: X List Dashboard（リポジトリ名: `x-list-dashboard`）
* プロジェクトの目的: X（旧Twitter）の複数アカウント（リスト）の投稿を1つの画面に集約し、既読管理・お気に入り・要約表示・読み上げ（TTS）で効率よく消化するための個人用ダッシュボード。
* 主な利用者: リポジトリ所有者（ochi1216）本人。未確認: 他の利用者の有無。
* 実行環境: ビルド不要の静的サイト（Vanilla HTML/CSS/JavaScript、単一ファイル）。GitHub Pages でホスティング。ブラウザ（PC/モバイル）から直接アクセスして利用する想定（`viewport-fit=cover` 等モバイル対応のCSSあり）。

## 2. Repository Structure

* 主要ファイル
  * `index.html` — アプリ本体。HTML/CSS/JavaScriptがすべて1ファイルに含まれる。Supabase REST APIへの直接アクセス（fetch）でデータを取得・更新する。
  * `.nojekyll` — GitHub PagesでJekyll処理を無効化するための空ファイル。
* 主要フォルダ
  * `.github/workflows/pages.yml` — `master` ブランチへのpush時にGitHub Pagesへ静的ファイルをデプロイするワークフロー。
  * `docs/` — 本セッションで新設。セッション間引き継ぎ管理用ドキュメント（本ファイル、`SESSION_HISTORY.md`、`NEXT_TASK.md`）を格納。
* 各ファイルの役割
  * `index.html` 内の主なパート:
    * Supabase接続設定（`SUPABASE_URL`, `SUPABASE_KEY` = publishable/anon key、ハードコード）
    * `sbFetch()` — Supabase REST APIへの共通fetchラッパー
    * `load()` — `x_posts` テーブルから直近30日分（+ `posted_at` が null のもの）を取得
    * `render()` / `buildRow()` — 投稿一覧・グループ表示のDOM構築
    * 読み上げ（TTS）関連のグローバル状態と `speechSynthesis` 制御（再生/停止、話速変更、カード送り・投稿者送り）
* README: 未作成（リポジトリ直下に `README.md` は存在しない、未確認: 今後作成するかどうか）

## 3. Current Functions

* Supabaseの `x_posts` テーブルから投稿一覧を取得・表示（直近30日 + `posted_at` null分）
* 投稿者ごとのグループ化表示（オン/オフ切り替え、投稿数順/名前順ソート）
* 検索（投稿者・本文でのフィルタ、`#search` 入力欄）
* ★（お気に入り）のトグル — Supabaseへ即時PATCH
* 既読/未読の管理 — 個別クリックで既読化、「すべて既読」「24H以内既読」の一括操作あり、既読は行の左ボーダーとグレーアウトで表現
* 未読のみ表示 / ★のみ表示のフィルタ
* アコーディオン開閉（全体折りたたみ/展開トグル、投稿ごとの詳細開閉、開閉状態は `collapsedUrls` にメモリ保持）
* 詳細表示欄に要約（`summary`）表示。要約が無い場合は「チャットで要約して」という案内文を表示（外部チャット連携で要約を作る運用を想定していると推測されるが、実装コードとしての自動要約生成機能は本リポジトリ内には未確認）
* 読み上げ（Text-to-Speech）フローティングボタン群
  * 再生/停止、話速切り替え（1.0x〜3.0x）
  * カード単位・投稿者単位でのナビゲーション（前後移動）
  * 読み上げ完了に応じた自動既読化、アクティブカードの自動スクロール
* 「再読込」ボタンでの再フェッチ

## 4. Confirmed Specifications

* データソースは Supabase の `public.x_posts` テーブル一本（他のテーブルとは無関係）。
* Supabaseへのアクセスはクライアントサイドから直接、`publishable`（anon）キーで行う。ビルドプロセスやサーバーサイドAPIは存在しない。
* `x_posts` の主なカラム（Supabase `list_tables` で確認済み、2026-07-16時点）:
  `id(uuid)`, `list_name(text)`, `author_handle(text)`, `author_name(text, nullable)`, `content(text)`, `post_url(text, unique)`, `posted_at(timestamptz, nullable)`, `fetched_at(timestamptz)`, `is_starred(bool)`, `summary(text, nullable)`, `summarized_at(timestamptz, nullable)`, `tags(text[], nullable)`, `gist(text, nullable)`, `is_read(bool)`
* 投稿データの新規取得（Xからのスクレイピング/収集）を行う仕組みは本リポジトリには含まれていない（未確認: 別リポジトリ or 外部ジョブで `x_posts` に書き込んでいる可能性が高いが、その実体はこのセッションでは特定できていない）。
* 既読/★状態はSupabase側に保存され、ローカルストレージ等でのキャッシュは行っていない（`localStorage` の使用箇所なし、確認済み）。
* デプロイは `master` ブランチへのpushをトリガーにGitHub Actions経由でGitHub Pagesへ自動反映される。

## 5. Current Status

* 完了済み
  * 投稿一覧表示・既読管理・お気に入り・検索・グループ化・読み上げ機能一式（`git log` 上のコミット履歴より、本セッション開始以前に実装済み）
  * GitHub Pagesへの自動デプロイ設定
  * セッション間引き継ぎ管理ファイル一式（`CLAUDE.md`, `docs/PROJECT_STATUS.md`, `docs/SESSION_HISTORY.md`, `docs/NEXT_TASK.md`）の初期設定（本セッションS01）
* 作業中
  * なし（本セッションはドキュメント整備のみ）
* 未着手
  * 次タスクは `docs/NEXT_TASK.md` を参照（本セッション終了時点では次タスク未確定）

## 6. Known Issues

* 既知の問題: 未確認（本セッションではコードの動作確認・バグ調査は実施していない）。
* 暫定対応: 該当なし（未確認）。
* 技術的リスク
  * Supabaseキーがクライアントサイド（`index.html`）にハードコードされている。anon/publishable key を前提とした設計と考えられるが、Row Level Security (RLS) の実際の設定内容（read/writeの許可範囲）はこのセッションでは未確認。
  * 投稿データを供給する外部の収集処理（スクレイパー等）の所在・実装が本リポジトリに存在しないため、データ更新の仕組み全体を把握するには別リポジトリの調査が必要（未確認）。
  * 自動テスト・Lintの仕組みが存在しない（後述）。

## 7. Test and Execution

* 起動方法: `index.html` をブラウザで直接開く、またはGitHub Pagesで公開されているURLにアクセスする（未確認: 公開URLの具体的なアドレス）。ローカルサーバーの起動やビルドコマンドは不要。
* テスト方法: 自動テストは存在しない（`package.json` 等のプロジェクト設定ファイルなし、テストコード・テストフレームワークの導入なし）。手動でのブラウザ動作確認のみ。
* 必要な環境変数: なし。`SUPABASE_URL` / `SUPABASE_KEY` は `index.html` 内に直書き。
* 外部サービスへの依存
  * Supabase（プロジェクトID: `bpdkdwtevqsqgsxlahmd`、リージョン: ap-northeast-1）— データの読み書き先。同一Supabaseプロジェクト内には本ダッシュボードと無関係な他プロジェクト用テーブル（`aikido_2026_*`, `ti_video_*`, `news_articles`, `learning_logs` 等）も同居しているため、スキーマ変更時は `x_posts` テーブル以外に影響を与えないよう注意する。
  * ブラウザの `Web Speech API`（`speechSynthesis`）— 読み上げ機能に使用。対応ブラウザ・OSでのみ動作。
  * GitHub Pages / GitHub Actions — デプロイ用。

## 8. Important Restrictions

* 変更禁止事項
  * `docs/NEXT_TASK.md` に明記されたタスク範囲外のファイル変更は行わない。
  * ユーザーの指示なく、既存の安定動作している機能（一覧表示・既読管理・読み上げ等）を削除・大幅変更しない。
* セキュリティ上の注意
  * Supabaseの `x_posts` 以外のテーブルへは、本プロジェクトの作業で触れない。
  * secret key（service_role等の強い権限を持つキー）を `index.html` や本リポジトリのどこにも記載しない。publishable/anon keyのみ許容。
* 後方互換性に関する注意
  * `x_posts` テーブルのカラム構成を変更する場合、`index.html` 側の参照箇所（`buildRow` 等）とスキーマの整合を必ず確認する。未確認: このテーブルへ書き込んでいる外部の収集処理側への影響有無。
