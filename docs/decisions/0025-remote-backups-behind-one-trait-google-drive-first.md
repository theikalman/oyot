# 0025: Remote backup destinations sit behind one trait, and Google Drive is linked like an account

- **Status:** Proposed
- **Date:** 2026-09-23
- **Extends:** [0024](0024-back-up-the-crdt-and-import-by-merging.md)

## Context

A backup on the same disk as the library does not survive the disk. The first
remote destination is Google Drive, and the design has to take other services
later without rework. The flow the user asked for is WhatsApp's: link a Google
account once, see which account is linked, and backups go there from then on.

The security model decides where this can live. The webview renders content
that arrived from other devices and is treated as untrusted. It has no
filesystem permission and holds no secrets, and a token that can write to the
user's Drive is a secret.

Google decides how an app may sign in. It refuses OAuth inside an embedded
webview, and the redirects it allows depend on the platform: a loopback address
for desktop apps, but not for Android or iOS clients.

## Decision

**1. A remote destination is a `BackupProvider` in Rust, and nothing else
knows which one it is.** The trait covers status, connect, disconnect, upload,
list, download and delete. The archive (ADR 0024) is built and read without
knowing where it goes, the commands take a provider id, and the settings page
renders whatever `list_backup_providers` returns. Adding Dropbox or WebDAV
later is one implementation and one line in the registry.

A provider whose credentials were not compiled into this build is not
registered. A development build without them still builds, and simply offers
backups to disk.

**2. Linking is explicit, and nothing reaches Drive without it.** Settings
shows "Link Google account". Linking shows Google's consent screen (decision
7 says how, per platform), and when it returns, the page shows the linked
account's email with "Unlink". Until an account is linked, Drive is not a
destination anyone can pick, manually or on a schedule.

Unlinking forgets the account on this device, and leaves the backups in Drive
where they are. A schedule that pointed at Drive stops and says why. It does
not revoke access with Google: Google's revocation covers the whole Cloud
project, so revoking from one device would cut off every device linked to the
same account. The confirmation says so, and says that removing Oyot from the
Google Account's security settings takes its access away everywhere. When the
user does that, the next call on each device fails and the page asks them to
link again. For the same reason, a consent with the Drive permission unticked
is refused and forgotten, not revoked.

**3. Sign-in is OAuth for installed apps, done in Rust.** On desktop:
authorization code with PKCE (S256), redirected to a one-shot listener on
`127.0.0.1` at a random port, with `state` checked on return. The browser is
the system one, opened through the opener plugin. Tokens never reach the
webview. The refresh token goes into the OS keychain through `keyring`
(Keychain on macOS, Credential Manager on Windows, Secret Service on Linux),
and the access token stays in memory and is refreshed when it expires. Where
no keychain is available, linking fails and says so, rather than writing a
refresh token to disk in clear. The phones differ only in how the consent
screen is shown and where the grant is kept (decision 7); the provider's Drive
calls are the same on every platform.

**4. The only scope is `drive.file`, and backups go in a folder the user can
see.** `drive.file` lets the app see and change the files it created and
nothing else. It is a non-sensitive scope, so it needs no security assessment
from Google. Backups go into an "Oyot Backups" folder, each tagged with
`appProperties` (a backup marker, the format version, when it was made, the
device's name, the document count), and the list is a query on those tags.
That way the list shows where each backup came from without downloading any of
them, and a backup the user moves elsewhere in their Drive is still found. The
linked account's email comes from Drive's `about` resource under the same
scope. If that ever stops holding, the `email` scope is also non-sensitive and
can be added.

WhatsApp keeps its backups in Drive's hidden app-data folder instead. A visible
folder is chosen for two reasons. The user can download a backup from Drive and
import it from disk, which is how a phone restores a Drive backup until it can
link an account itself (decision 7). And the user can see, and delete, what
the app has stored in their account.

**5. Uploads resume, and downloads are validated like any file.** Uploads use
Drive's resumable protocol in 8 MiB chunks. After a network failure or a server
error the app asks how much arrived and continues from there, so a large backup
on a poor connection does not start over. A download is streamed to the
staging directory and then goes through exactly the validation a file picked
from disk does (ADR 0024, decision 5). Nothing from Drive is trusted more than
a file from disk.

**6. The client id is compiled in, and the publisher sets Google up once.**
Each platform has its own OAuth client, all in one Cloud project, since
`drive.file` access and consent belong to the project, and backups made on one
device have to be listed on another:

- desktop: `OYOT_GOOGLE_CLIENT_ID` and `OYOT_GOOGLE_CLIENT_SECRET`, a Desktop
  client. For an installed app the secret is not actually secret, which is
  why PKCE carries the security.
- iOS: `OYOT_GOOGLE_IOS_CLIENT_ID`, an iOS client for the bundle id. Google
  gives iOS clients no secret at all.
- Android: nothing but `OYOT_GOOGLE_ANDROID=1`, the switch that says the
  project has an Android client for this build. Google Play services
  recognises the app by its package name and signing certificate, so every
  signing key (debug, release, Play App Signing) needs its fingerprint
  registered.

They are read at build time, from CI secrets for a release. A build without
one simply offers no Drive on that platform. Creating the Cloud project, the
consent screen and the clients is a one-time task for whoever publishes Oyot,
written up in DEVELOPMENT.md. Users never see any of it; they see "Link Google
account".

**7. On phones, the platform shows the consent screen, and a small plugin of
our own hands the result to Rust.** Google blocks the loopback redirect for
mobile clients. A spike (2026-09-23) settled the rest, and overturned this
decision's first guesses on both platforms:

- **iOS: Apple's web authentication session.** The same flow as desktop, with
  the consent page in an `ASWebAuthenticationSession` sheet and the redirect
  under the client's reversed-id scheme
  (`com.googleusercontent.apps.<id>:/oauth2redirect`). The session hands that
  address to this app alone, even if another app claims the scheme, so no
  URL type is registered and the deep-link plugin is not used: it would have
  broadcast the authorization code to the webview. PKCE, the code exchange
  and refresh stay in Rust, with no client secret. The refresh token goes in
  the data protection keychain, readable after first unlock and never
  migrated to another device.
- **Android: Google Play services' `AuthorizationClient`.** Credential Manager
  is for signing in, not for API access. `AuthorizationClient` asks the user
  once, keeps the grant itself, and from then on hands out one-hour access
  tokens without showing anything. It never hands the app a refresh token, and
  Google advises against keeping one on a device, so nothing secret is stored:
  the link is only which account it is, in a file of the app's own. A token
  Drive refuses is handed back to Play services before another is asked for. A
  device without Google Play services cannot link, and says so.

The native side is one in-repo plugin, `src-tauri/plugins/sign-in`, called
from Rust only: it has no commands the webview may call, and no capability
grants it any. Scheduled backups ask the plugin for nothing that could show UI;
a grant that needs the user ends the link, and the page asks for it again.
Backups to disk work on every platform regardless.

**8. HTTP is `reqwest`, on rustls with the `ring` provider.** `reqwest` is
already in the dependency tree through Tauri, without TLS. Its default TLS
provider is `aws-lc-rs`; `ring` is the provider Tauri itself selects when it
enables rustls, and keeping to one provider keeps one C crypto library in the
Android and iOS cross builds. Certificates are checked by the platform's own
verifier, except on Android, where they are checked against Mozilla's roots
bundled at build time: reqwest's verifier there needs JNI set up by the app
before its first request, and panics without it. The cost is that a CA the
user or their employer installed is not trusted for these few Google hosts.

## Alternatives considered

**The hidden app-data folder (`drive.appdata`).** What WhatsApp does, and also
a non-sensitive scope. The user cannot see or download backups there, which
removes the only way a phone can restore a Drive backup before decision 7
lands, and hides the app's storage in the user's own account from them.

**The full `drive` scope.** It would let the app import any zip anywhere in the
user's Drive. It is a restricted scope, which means an annual third-party
security assessment, and it is far more access than a backup needs.

**Sign in inside the app's webview.** Google blocks it, and it would put the
user's Google password into the surface the security model treats as
untrusted.

**Providers in TypeScript.** The webview can make HTTP requests, and a provider
there would mean less Rust. It would also hold the token, which is the one
thing this design keeps out of the webview.

**A server of ours that holds the tokens and talks to Drive.** Oyot has no
server by design; ADR 0022 removed the last piece of shared infrastructure.
Adding one for backups would make the user's backups depend on it.

## Consequences

- **Someone has to register Oyot with Google.** While the consent screen is in
  testing, only listed test users can link, and Google expires their links
  after seven days. Publishing it needs a privacy policy URL, and because
  `drive.file` is non-sensitive, no security assessment.
- **Linux without a Secret Service cannot link.** Rare on a full desktop
  install, more common on a minimal one. The failure says what is missing.
- **Google can read the backups**, as can anyone with access to the account,
  until they are encrypted (ADR 0024, decision 6).
- **Backups are visible only to Oyot builds that share this Google Cloud
  project.** `drive.file` access is per project, so a fork with its own client
  id cannot see backups made by the official build, and the reverse.
- **The TLS stack comes back.** ADR 0022 removed rustls along with MQTT; this
  brings it back to every build, and the binaries grow by rustls and `ring`,
  and on Android by the bundled roots.
- **Unlinking one device leaves the others linked.** Taking Oyot's access away
  everywhere is done in the Google Account, which the confirmation says.
- **Android needs Google Play services,** and every signing key's fingerprint
  registered with Google. A key that is not fails at linking time with a
  message, not at build time.
