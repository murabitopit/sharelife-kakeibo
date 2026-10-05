// 同棲タブの端末間同期(Firebase)用の設定ファイル。
//
// 【設定手順】
// 1. https://console.firebase.google.com/ で無料のFirebaseプロジェクトを新規作成する
//    (Googleアカウントでログインするだけ。クレジットカード登録は不要)
// 2. 左メニュー「構築」→「Firestore Database」を開き、「データベースの作成」
//    → ロケーションは asia-northeast1(東京) などお好みで → 本番環境モードで開始
// 3. 作成後、「ルール」タブを開き、下記の内容に書き換えて「公開」する
//    (2人だけの合言葉(ペアリングコード)を知っている人だけが読み書きできるようにする簡易ルール):
//
//      rules_version = '2';
//      service cloud.firestore {
//        match /databases/{database}/documents {
//          match /households/{code} {
//            allow read, write: if request.auth != null;
//          }
//        }
//      }
//
// 4. 左メニュー「構築」→「Authentication」→「Sign-in method」で
//    「匿名」プロバイダを有効にする(このアプリはログイン画面を持たないため、
//     端末ごとに自動で匿名サインインして使う)
// 5. 左メニューの歯車アイコン→「プロジェクトの設定」→下の方の「マイアプリ」で
//    「</>」(ウェブ)アイコンをクリックしてウェブアプリを登録する(アプリ名は何でも良い)
// 6. 表示される firebaseConfig の中身を、下の window.FIREBASE_CONFIG にそのままコピーする
// 7. 保存してデプロイ(git push)すれば、設定タブに「同期」のメニューが使えるようになる
//
// 値を入れるまでは同期機能は無効なままで、アプリの他の機能(今まで通りの1台での利用)には
// 一切影響しません。
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBzTmOIlFDcQAwZVu6SAri05cbLsSi-bj0",
  authDomain: "sharelife-69078.firebaseapp.com",
  projectId: "sharelife-69078",
  storageBucket: "sharelife-69078.firebasestorage.app",
  messagingSenderId: "889502286445",
  appId: "1:889502286445:web:612c6465cd8d2e6a45f564",
  measurementId: "G-1VCMRMNB63",
};
