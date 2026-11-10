# Laplace Point

Point is an opt-in Desktop feature under **On this device → Tools**. It works without a Laplace account. The default global shortcut is **Control+L on both Windows and macOS**; the tray also has **Capture with Point**. Enabling it takes that shortcut away from other applications. A registration conflict leaves the tray action available and explains how to change the shortcut.

## Capture and delivery

Point freezes all attached screens before bringing Codex forward. Each monitor has a separate sandboxed selection overlay; one capture stays within one monitor. Escape cancels. Display-local coordinates are converted using the actual captured raster dimensions, including fractional scaling and displays positioned above or left of the primary screen. Full-screen pixels stay in memory. Only the selected PNG and its small capture record are saved.

Point remembers the most recently active Codex window without activating it. The selection overlay appears before any Codex keyboard or clipboard operation. Switching away from the overlay cancels selection. After the crop is saved, the native adapter obtains the current chat's existing-chat deep link in that remembered window using **Copy chat deep link**, and checks it again before delivery. It never chooses another window or opens a new-chat link during handoff. Closing the window, switching chats during handoff, ambiguous controls, permission denial, and interrupted operations retain the crop and report a recoverable error. Clipboard data is reconstructed with all available formats and restored only while Point still owns the clipboard.

On qualified Codex versions, Point opens a dedicated local snip page, clicks its **Annotate this snip** button through native input, verifies that a native annotation editor exists, and focuses its comment field. The user types and saves. Point observes the saved context, completes a separate **Add to chat/context** action if needed, and verifies the draft context. There is no chat-submit operation. Existing draft text, attachments, and annotations remain in place.

Other versions use a PNG attachment and focus the composer. Success requires observing an additional attachment. Point persists the attempt before pasting; an uncertain result is not automatically retried, including after a restart. **Copy snip** is the manual recovery path. Repeated successful captures append to the draft.

## Native qualification status

Native annotation delivery is enabled for Windows x64 build `OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0`. See [the observed qualification evidence](point-windows-26.1023.6621.md). On this build, **Ctrl+Enter inside the native comment popup adds to the draft**; ordinary Enter sends. Point shows this instruction and never presses either comment-submit shortcut. The original PNG is appended after saving the comment because independent offline image durability has not been established. Other builds retain attachment fallback through the exact version allowlist.

Windows compilation, packaged settings/shortcut-conflict tests, packaged Desktop/native-runtime smoke tests, and live Codex window/composer identification and chat-link binding have been exercised. The native Windows route now opens the browser, verifies the pasted URL, requests the annotation, and verifies comment focus. Saving was observed as a removable annotation chip in the draft, without a separate staging step. Source and Chromium tests cover permission transitions, delayed draft updates, cancellation, geometry, storage, loopback boundaries, clipboard restoration, and handoff state transitions. macOS compilation, signing/TCC permissions, physical mixed-DPI capture, and the macOS native draft workflow remain release checks. The approximately two-second warm snip-to-editor target is not yet established.

The Windows focus adapter waits for Chromium's asynchronous focus update and recognizes a focused text descendant of the selected editor. If accessibility focus alone does not work, it clicks the editor's observed bounds and verifies focus before pasting. A live check on `OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0` verified the transition from a separate test window back to the bound chat's composer, with existing attachment/annotation counts unchanged. No test message was submitted. Focus failure occurs before the persisted paste-attempt marker, so a retained snip remains retryable.

## Components and boundaries

- `src/main/point.ts` owns settings, shortcut registration, in-memory screen capture, overlay lifecycle, cropping, and delivery. Sleep/lock cancels capture and stops annotation monitoring.
- `src/main/point-preload.ts` exposes only overlay initialization, crop selection, and cancellation. Main checks the sender, frame, and URL, and validates each payload. The overlay has no Desktop management bridge. `src/main/renderer-protocol.ts` registers the bundled page handler separately for the main session and the isolated overlay session; scheme registration alone does not install a handler in another partition.
- `src/point/handoff.ts` implements typed `editor-ready`, `draft-ready`, `attachment-ready`, and error outcomes. It never treats a successful API request or elapsed time as delivery.
- `src/point/native.ts` launches a bounded native process with fixed operations and a bounded JSON response. Windows uses UI Automation and SendInput; macOS uses Accessibility and native events. It uses semantic controls and their observed bounds, not fixed screen coordinates. The shortcut is suspended during synthetic input.
- `src/point/server.ts` binds only to `127.0.0.1` on an ephemeral port. Exact Host/Origin checks, 256-bit capture tokens, no-store responses, a restrictive CSP, and a tiny status endpoint isolate the page. It exposes no management API or filesystem browsing. The page identifies the image as a screenshot, not the captured application's DOM.
- Crops are stored in Electron's user-data directory under `point/captures`, with random IDs and restrictive file modes. Metadata updates use atomic replacement. Seven-day cleanup runs at startup and hourly. **Clear Point captures** removes retained crops. Clearing/expiry makes old local pages unavailable; this does not retract images already in Codex.

## Build and check

Use the repository's Node and pnpm versions. Runtime preparation builds the adapter automatically on the matching host OS. Windows needs the x64 MSVC toolchain and Windows SDK in Developer PowerShell; macOS needs Xcode command-line tools. No native adapter is built for Linux.

```sh
pnpm --filter @repo/desktop check:source
pnpm --filter @repo/desktop build:point-native
pnpm --filter @repo/desktop package
pnpm --filter @repo/desktop test:electron -- --packaged
pnpm --filter @repo/desktop test:native -- --packaged
```

The browser tests require Playwright Chromium. The packaged Electron smoke includes signed-out Point settings, shortcut conflict/recovery, actual overlay loading with a frozen screen in its isolated session, Escape cancellation, and shortcut unregistration. It discards captured pixels without saving a crop or altering a real Codex draft. Production adapter controls currently use English accessible labels. Other languages fail closed with Copy snip recovery until their controls are qualified.

## Qualification protocol

Run this against the actual packaged and signed Desktop build on each platform. Keep evidence under a release-specific document and reference that document from the qualification record. Use an existing disposable Codex chat and synthetic images. Never submit a chat message during this protocol.

1. Record Desktop version, exact adapter-reported Codex version, platform/architecture, display layout/scales, and required permissions. Verify denied Screen Recording/Accessibility and denied site-annotation permission produce recovery guidance. On macOS, check permission attribution to the packaged helper as well as the Laplace app.
2. Prove the native route first: open a synthetic snip in the bound chat's browser; verify whole-image selection and focused comment; type a sample comment; save; complete any staging action; verify exactly one new annotation in the same draft and no submitted message. Record the actual editor/staging/context labels and update the adapter only from observed controls.
3. Stop the local server and inspect/reopen the draft annotation. Confirm its image content remains usable. If this cannot be established, set `annotationImageDurable` to `false`, require the original PNG attachment, and verify that attachment survives after the server stops. Do not claim model-side image fidelity without a separate explicitly authorized send test.
4. Repeat with existing text, images, annotations, multiple Codex windows, a different active app, a chat switch during selection, an open annotation editor, and saved context awaiting staging. Existing draft content must remain unchanged. Verify further snips append.
5. Exercise fallback on an unsupported build/API, focus loss, a closed Codex window, sleep/lock, and interruption immediately after paste. Neither restart nor Retry may duplicate an uncertain attachment. Check PNG/HTML/text clipboard formats and clipboard changes made by the user during handoff.
6. Test selection at every monitor edge, negative origins, Retina, mixed/fractional DPI, different monitor orientations, drag crossing a boundary, repeated shortcuts, cancellation, and shortcut conflicts. Verify pixels against a known calibration image. Only the selected PNG may reach disk.
7. Run source, browser, native, and packaged smoke checks. Probe the snip page from an unexpected Host/Origin, expired/invalid token, iframe, and attempted Desktop IPC. Measure warm selection-to-editor latency over multiple runs and report median/p95 against the approximately two-second target.
8. Only after all applicable checks pass, add the exact version to `qualifications.json` with `annotationDraft: true`, the verified durability result, and the evidence path. Requalify changed Codex builds; do not use wildcard versions. Until then, retain attachment fallback.

References: [Electron capture](https://www.electronjs.org/docs/latest/api/desktop-capturer), [global shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut), [native annotation requests](https://learn.chatgpt.com/docs/annotations-extensibility#open-an-annotation-from-your-website), and [Codex commands](https://learn.chatgpt.com/docs/reference/commands).
