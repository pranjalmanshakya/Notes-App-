# Notes: phone notes app

An installable notes app (PWA) for Android. On the CMF Phone 2 Pro it runs full-screen from the home screen, like a native app.

**Features**
- Multiple notes, with search and pin-to-top
- Typed notes with bold, italic, underline, strikethrough, headings, bullet lists, numbered lists and checklists
- Handwriting like Samsung Notes: pen, highlighter, eraser, 7 colours, pen size, undo and redo. Draw with one finger and scroll with two.
- Screenshots: share them from the Gallery or the screenshot preview to **Notes**, paste them, or tap the 🖼 button
- Google Drive backup and sync. Each note is saved in a **Notes App** folder in your Drive.
- Works offline. Notes are stored on the phone and sync when you're back online.
- Export and import a backup file

## 1. Put it online (HTTPS is required)

Android only installs PWAs served over HTTPS, and Google sign-in needs it too. Upload this folder to any free static host, for example:
- **Netlify**: drag the `notes-app` folder onto https://app.netlify.com/drop
- **GitHub Pages**: push the folder to a repo and enable Pages

You'll get a URL like `https://my-notes.netlify.app`. (`serve.js` is only for local testing on a PC.)

## 2. Install it on the phone

Open the URL in **Chrome** on the phone, then tap ⋮ → **Add to Home screen** → **Install**.
Once it's installed, **Notes** also shows up in Android's Share menu.

## 3. Connect your Google account (one-time, about 5 minutes)

Google requires every app that touches Drive to have its own OAuth Client ID. You create it once:

1. Go to https://console.cloud.google.com/ and create a project, for example "My Notes".
2. Open **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. Open **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type: **External**. App name: "Notes". Use your email for the support and contact fields.
   - Under **Audience / Test users**, add your own Gmail address.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**: add your site URL, for example `https://my-notes.netlify.app`, with no trailing slash
   - Click Create and copy the **Client ID** (it ends in `.apps.googleusercontent.com`)
5. In the app, tap ⚙ → paste the Client ID → **Connect Google** → choose your account → Allow.

The app only asks for the `drive.file` permission. That lets it see only the files it creates, not the rest of your Drive.

Google's sign-in token lasts about an hour. When the cloud icon turns red, tap it to reconnect. This takes one tap and syncs right away.

## Using it
| Do this | How |
|---|---|
| New note | Orange **+** button |
| Handwrite | Tap ✎ in the note. Draw with 1 finger, scroll with 2, and tap ✎ again to go back to typing |
| Add a screenshot | Take a screenshot → **Share** → **Notes**, or tap 🖼 in a note |
| Tick a checklist item | Tap its box |
| Pin, clear handwriting or delete | ⋮ menu in a note |
| Sync now | Cloud icon on the main screen |
