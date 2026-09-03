# ComfyUI H3 Anime Auto Director

大まかなストーリーと1～9枚の参照画像から、MiniMax H3 ref2va用のアニメーションプロンプトをAIで作り、ComfyUIへクリップ単位で連続投入するWindows向けローカルコントローラーです。

AIが自動で設計するもの：

- 参照画像に沿ったキャラクター定義と同一性保持
- 日本の2Dアニメーション向けの芝居、ポーズ、表情、カメラ
- 自然な日本語の台詞
- キャラクターに合うオリジナルの声質とプロ声優的な演技指示
- 口の動き、呼吸、間、環境音、効果音、劇伴
- 15秒以下のクリップへの分割と、各クリップのH3六セクションプロンプト

MP3、SRT、字幕、画面内テキスト、リリックモーションは使用しません。音声はH3のネイティブ音声生成を使います。

## 必要なもの

- Windows
- Node.js LTS
- ComfyUI（通常は `http://127.0.0.1:8188`）
- MiniMax H3 ref2vaのAPI形式ワークフローJSON
- Codex CLI（インストール済み・ログイン済み）

H3公式ref2vaワークフローは、最大9枚の参照画像とネイティブ音声出力に対応する構成を使用してください。

## 起動

1. ZIPを新しいフォルダーへ展開します。
2. `start_windows.bat`を実行します。
3. ブラウザーで `http://127.0.0.1:3030` が開きます。

外部npmパッケージは不要です。

## 使い方

1. 大まかなストーリー、全体秒数、アニメ演出、台詞量、必要なら声の希望を入力します。
2. キャラクターや背景の参照画像を1～9枚D&Dします。順番が `<Picture 1>`～`<Picture 9>`になります。
3. PowerShellで一度 `codex` を起動してChatGPTへログインし、WEB画面の「Codex CLI確認」を押します。
4. 必要ならCodexモデルを指定し、「AIで脚本・演技・台詞を生成」を押します。
5. ComfyUI URL、inputフォルダー、`workflow_api.json`を設定します。
6. 自動推定されたプロンプト入力と、必要なら保存名・Seedを確認します。
7. 「アニメを連続生成」を押します。

API URLとAPIキーの入力はありません。ローカルサーバーが `codex exec` を非対話モードで起動し、Codex CLIに保存済みのログイン状態を使います。参照画像は一時フォルダーにだけ展開し、生成終了後に削除します。

Codex CLIが未導入の場合：

```powershell
npm install -g @openai/codex
codex
```

RunnerはWindowsのPATHに加え、`%APPDATA%\npm\codex.cmd`と`%LOCALAPPDATA%\npm\codex.cmd`も自動検索します。

## 参照画像の接続

D&D枚数がそのままH3入力数になります。

- 1枚: `<Picture 1>` → `ref_images.ref_image_0`
- 2枚: `<Picture 1～2>` → `ref_images.ref_image_0～1`
- 9枚: `<Picture 1～9>` → `ref_images.ref_image_0～8`

不足する標準`LoadImage`ノードは、実行用APIワークフロー内へ自動生成し、IMAGE出力0をH3へ直結します。元のJSONファイルは変更しません。

## AI生成スキル

システムがAIへ渡す汎用スキルは次に同梱されています。

- `skills/japanese-anime-ref2va-prompter/SKILL.md`
- `skills/japanese-anime-ref2va-prompter/references/output-schema.md`
- `skills/japanese-anime-ref2va-prompter/references/output-schema.json`

このスキルは、H3 full-reference形式の六セクション、`<Picture N>`、`<Subject N>`、安定した`(S1)`話者ID、`<d>[Japanese] ...</d>`形式の日本語台詞を強制します。また、外部音声、MP3、SRT、字幕、キャプション、吹き出し、リリック文字、実在声優の模倣を禁止します。

## Codex CLI

生成には次の形式を使用します。

```text
codex exec --sandbox read-only --skip-git-repo-check \
  --output-schema output-schema.json -o anime-project.json \
  --image picture-1.png --image picture-2.png -
```

プロンプトは標準入力から渡します。WEB画面のモデル欄を空欄にするとCodex CLI側の既定モデルを使用し、入力した場合だけ `--model` で上書きします。CLIの進捗はサーバー側で受け取り、最終JSONだけを読み込んで検証します。

## トラブルシューティング

- `API形式のノードが見つかりません`: ComfyUIで通常保存ではなく「Save (API Format)」を使用します。
- `MiniMax H3 Reference-to-Videoノードを検出できません`: ref2va用ワークフローを読み込んでください。
- `画像入力を自動生成できません`: ComfyUIとH3ノードを更新し、APIワークフローを保存し直します。
- `Codex CLIが見つかりません`: PowerShellで `npm install -g @openai/codex` を実行後、`codex`を一度起動してログインします。必要なら `where.exe codex` の結果を画面へ貼り付けます。
- `Codex CLI実行エラー`: `codex`を起動してログイン状態、モデル名、ネットワーク接続を確認します。
- `AI応答のJSONを解析できません`: Codexが返した最終出力をログで確認し、再生成します。
- 字幕禁止文が別表現または欠落: 意味が同じ禁止表現は受理し、完全に欠けている場合はRunnerが`detailed_description`へ正式な禁止文を自動補完します。字幕表示を求める指示がある場合だけ停止します。
- `Failed to fetch`: `start_windows.bat`の黒い画面を閉じず、`http://127.0.0.1:3030`を使用します。

実行ログはOSの一時フォルダー内 `comfyui-h3-anime-runner/runner.log` に保存されます。
