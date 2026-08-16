# WebアプリのVercel公開・運用手順書（GitHub連携版）

本書では、プライベートGitHubリポジトリとVercelを連携させ、他のPCやスマートフォンから本アプリにセキュアにアクセスできる環境を構築する手順を説明します。

---

## 全体構成と前提条件
- **リポジトリ**: GitHub（非公開 / Privateリポジトリ）
- **ホスティング**: Vercel（無料プランで利用可能）
- **バックエンド**: Firebase (Firestore & Authentication)
- **必要なもの**:
  - GitHubアカウント
  - Vercelアカウント
  - Gitが利用可能なPC環境（Git BashやVSCodeなど）
  - 現在使用しているFirebaseプロジェクトへの管理アクセス権

---

## ステップ 1: GitHubにプライベートリポジトリを作成してプッシュする

ローカルにあるコードをGitHubにプッシュし、Vercelが自動デプロイできるようにします。

### 1-1. GitHubでリポジトリを作成
1. [GitHub](https://github.com/) にログインし、右上の「＋」アイコンから **New repository** を選択します。
2. 以下のように設定します：
   - **Repository name**: `progress-gantt-todo-sync` (任意)
   - **Public/Private**: 必ず **Private** にチェックを入れてください（コードやFirebaseのキーが含まれるため非公開にします）。
   - その他の設定（Add a README fileなど）はチェックを外した状態にします。
3. **Create repository** をクリックします。

### 1-2. ローカルコードをGitHubにプッシュ
Gitのターミナル（Git Bash、コマンドプロンプト、VSCodeの内蔵ターミナル等）を開き、プロジェクトのルートディレクトリで以下のコマンドを実行します。

```bash
# 1. Gitの初期化 (すでに行っている場合は不要ですが、念のため実行して問題ありません)
git init

# 2. すべてのファイルをステージングエリアに追加
git add .

# 3. コミットを作成
git commit -m "Initial commit with localized UI"

# 4. メインブランチの名前を main に変更
git branch -M main

# 5. リモートリポジトリ（GitHub）の登録
# ※ [ユーザー名] と [リポジトリ名] は、GitHubで作成した画面に表示されるURLに書き換えてください。
git remote add origin https://github.com/[あなたのユーザー名]/progress-gantt-todo-sync.git

# 6. GitHubにプッシュ
git push -u origin main
```

---

## ステップ 2: Vercelにプロジェクトをインポートしてデプロイする

GitHubのリポジトリとVercelを紐付け、`docs` ディレクトリを公開用ディレクトリとして設定します。

### 2-1. Vercelへのログインと連携
1. [Vercel](https://vercel.com/) にアクセスし、GitHubアカウントでログイン（Sign In with GitHub）します。
2. ダッシュボードの右上にある **Add New...** -> **Project** をクリックします。

### 2-2. プロジェクトのインポートと設定
1. **Import Git Repository** のリストから、先ほど作成した `progress-gantt-todo-sync` リポジトリの横にある **Import** をクリックします。
   *(※ リポジトリが表示されない場合は、"Configure GitHub App" から対象リポジトリへのアクセスを許可してください)*
2. 設定画面（Configure Project）で以下のように設定します：
   - **Project Name**: 自動入力されます（そのままでOK）。
   - framework Preset: `Other`（そのままでOK）。
   - **Root Directory**: **【重要】** **`docs`** に設定します。
     - 「Edit」をクリックし、フォルダ一覧から `docs` フォルダを選択して「Continue」をクリックします。これによって、Vercelは `docs` フォルダ内にある `index.html` をルート（トップページ）として公開します。
3. その他の設定（Build and Output Settings や Environment Variables）は変更せず、そのままにしておきます。
4. **Deploy** をクリックします。

数分でビルドとデプロイが完了し、`https://[プロジェクト名].vercel.app` という公開用URLが発行されます。

---

## ステップ 3: Firebase Authentication の承認済みドメインを設定する

現状のままでは、VercelのURLからログインしようとしてもFirebase側でセキュリティエラー（Googleサインイン等の拒否）が発生します。FirebaseにVercelのドメインを許可する設定を追加します。

1. [Firebase コンソール](https://console.firebase.google.com/) にログインし、対象のプロジェクトを選択します。
2. 左メニューから **Build (構築)** -> **Authentication (認証)** を選択します。
3. 画面上部のタブから **Settings (設定)** を選択し、左側のメニューから **Authorized domains (承認済みドメイン)** をクリックします。
4. **Add domain (ドメイン of 追加)** をクリックします。
5. Vercelで作成されたURLのドメイン部分を入力します。
   - 例: `progress-gantt-todo-sync.vercel.app` (※ `https://` や末尾の `/` は除いて入力します)
6. **Add (追加)** をクリックして保存します。

これで、他のPCやスマートフォンのブラウザから Vercel のURLにアクセスし、正常にログインおよびデータ同期が行えるようになります。

---

## 継続的な変更とアップデート方法
今後、アプリのコード（`index.html`など）を書き換えて再度公開したい場合は、ローカルの変更をGitHubにプッシュするだけで、Vercelが自動的に検知して数秒で本番環境へデプロイしてくれます。

```bash
git add .
git commit -m "UIや機能の修正"
git push origin main
```
これだけでデプロイ作業は完了します。
